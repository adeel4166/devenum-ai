import path from "path";
import dotenv from "dotenv";
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, GuildTextBasedChannel, AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction, Client, EmbedBuilder, Events,
  GatewayIntentBits, Interaction, Message, MessageFlags, ModalBuilder, ModalSubmitInteraction, PermissionFlagsBits, REST, Routes,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { Actor, AgentRow, ApiError, BackendApi, MergedProposal, PreviewInfo, TeamPlan } from "./api";
import { chat, chunks } from "./chat";
import { BADGE, channelAgent, findAddressedAgent, sendAs, setupTeamChannels } from "./agents";
import { syncProjects } from "./projectsync";
import { authStatus, startLogin, submitCode } from "./claudeLogin";
import {
  CORE_SERVICES, decisionButtons, deleteConfirmButtons, deployButtons, githubButtons, ids, previewButtons, proposalEmbed, retryButton,
  statusEmbed, systemButtons, systemEmbed,
} from "./ui";

const env = (k: string, required = true) => {
  const v = process.env[k]?.trim() ?? "";
  if (required && !v) throw new Error(`${k} is missing in bot/.env`);
  return v;
};
const TOKEN = env("DISCORD_BOT_TOKEN");
const GUILD_ID = env("DISCORD_GUILD_ID");
const CHANNEL_ID = env("DISCORD_APPROVAL_CHANNEL_ID");
const api = new BackendApi(env("BACKEND_URL", false) || "http://127.0.0.1:4200", env("BOT_SERVICE_TOKEN"));
const ALLOWED = new Set(env("DISCORD_ALLOWED_USER_IDS", false).split(",").map(s => s.trim()).filter(Boolean));
const POLL_MS = Number(process.env.PROPOSAL_POLL_INTERVAL_MS || 10_000);
// Optional free-chat channels (names or IDs, e.g. "general,chat"). Empty = mention-only chat.
const CHAT_CHANNELS = new Set(env("DISCORD_CHAT_CHANNELS", false).split(",").map(s => s.trim().replace(/^#/, "").toLowerCase()).filter(Boolean));
// Updated from the backend on every heartbeat (GITHUB_TOKEN lives in backend/.env).
let githubEnabled = false;
const TEAM_CATEGORY = process.env.TEAM_CATEGORY_NAME?.trim() || "DEVENUM AI TEAM";

const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) =>
  console[level === "info" ? "log" : level](JSON.stringify({ ts: new Date().toISOString(), level, service: "devenum-bot", msg, ...extra }));

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

/** Agents are cached briefly so autocomplete and chat always reflect the database (new agents appear automatically). */
let agentCache: { at: number; rows: AgentRow[] } | null = null;
async function getAgents(): Promise<AgentRow[]> {
  if (!agentCache || Date.now() - agentCache.at > 60_000) agentCache = { at: Date.now(), rows: await api.agents() };
  return agentCache.rows;
}

const projectOpt = (o: import("discord.js").SlashCommandIntegerOption) => o.setName("project_id").setDescription("Project ID (see /status)").setRequired(true).setMinValue(1);

function buildCommands() {
  return [
    new SlashCommandBuilder().setName("project-create").setDescription("Create a new Devenum AI project")
      .addStringOption(o => o.setName("name").setDescription("Project name").setRequired(true).setMinLength(2).setMaxLength(120))
      .addStringOption(o => o.setName("type").setDescription("Project type").setRequired(true)
        .addChoices({ name: "Web", value: "WEB" }, { name: "Mobile app", value: "MOBILE_APP" }, { name: "Game", value: "GAME" }))
      .addStringOption(o => o.setName("description").setDescription("What should be built").setRequired(true).setMaxLength(2000)),
    new SlashCommandBuilder().setName("task-add").setDescription("Add a READY task for an agent")
      .addIntegerOption(projectOpt)
      .addStringOption(o => o.setName("title").setDescription("Task title / instructions").setRequired(true).setMinLength(2).setMaxLength(200))
      .addStringOption(o => o.setName("agent_role").setDescription("Agent that should do the work (loaded live from the backend)").setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName("priority").setDescription("Priority (default MEDIUM)").setRequired(false)
        .addChoices(...PRIORITIES.map(p => ({ name: p, value: p }))))
      .addStringOption(o => o.setName("description").setDescription("Detailed requirements / acceptance criteria").setRequired(false).setMaxLength(4000)),
    new SlashCommandBuilder().setName("status").setDescription("Active projects, running agents and pending approvals"),
    new SlashCommandBuilder().setName("approvals").setDescription("List pending proposals with Approve / Request Changes / Reject buttons"),
    new SlashCommandBuilder().setName("ask").setDescription("Chat with the Executive Assistant (brainstorming, Q&A, research, document analysis)")
      .addStringOption(o => o.setName("prompt").setDescription("Your question or idea").setRequired(true).setMaxLength(4000))
      .addAttachmentOption(o => o.setName("file").setDescription("Optional file: .md .txt .json .csv .pdf .docx").setRequired(false))
      .addAttachmentOption(o => o.setName("file2").setDescription("Optional second file").setRequired(false))
      .addAttachmentOption(o => o.setName("file3").setDescription("Optional third file").setRequired(false)),
    new SlashCommandBuilder().setName("github-push").setDescription("Create the GitHub repo (if needed) and push the project's main branch")
      .addIntegerOption(projectOpt)
      .addStringOption(o => o.setName("visibility").setDescription("Repository visibility").setRequired(true)
        .addChoices({ name: "private", value: "private" }, { name: "public", value: "public" })),
    new SlashCommandBuilder().setName("preview").setDescription("Start a live preview server for a project workspace").addIntegerOption(projectOpt),
    new SlashCommandBuilder().setName("preview-stop").setDescription("Stop a project's live preview").addIntegerOption(projectOpt),
    new SlashCommandBuilder().setName("download").setDescription("Download the project workspace as a ZIP").addIntegerOption(projectOpt),
    new SlashCommandBuilder().setName("auto-build").setDescription("Plan a goal into 3–5 sequential agent tasks and queue them")
      .addIntegerOption(projectOpt)
      .addStringOption(o => o.setName("goal").setDescription("High-level goal, e.g. 'a landing page with signup form and API'").setRequired(true).setMinLength(5).setMaxLength(3000)),
    new SlashCommandBuilder().setName("handoff").setDescription("Queue a task to produce client-ready README, setup guide and .env.example").addIntegerOption(projectOpt),
    new SlashCommandBuilder().setName("project-delete").setDescription("Delete a project, its records, workspace, preview and live deploy (asks to confirm)").addIntegerOption(projectOpt),
    new SlashCommandBuilder().setName("deploy").setDescription("Build and deploy a project permanently (PM2 live-<slug>, ports 5201–5299)").addIntegerOption(projectOpt),
    new SlashCommandBuilder().setName("system").setDescription("VPS CPU / RAM / disk and Devenum service status, with restart buttons"),
    new SlashCommandBuilder().setName("backup").setDescription("Create a full agency backup (database + workspaces)"),
    new SlashCommandBuilder().setName("chat-agent").setDescription("Talk directly to a specific agent (replies as that agent)")
      .addStringOption(o => o.setName("agent").setDescription("Which agent").setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName("prompt").setDescription("Your message").setRequired(true).setMaxLength(4000))
      .addAttachmentOption(o => o.setName("file").setDescription("Optional file: .md .txt .json .csv .pdf .docx").setRequired(false)),
    new SlashCommandBuilder().setName("decide").setDescription("Pin a canonical decision to a project (injected into every agent prompt)")
      .addIntegerOption(projectOpt)
      .addStringOption(o => o.setName("decision").setDescription("The decision, e.g. 'Use PostgreSQL with Prisma'").setRequired(true).setMaxLength(4000))
      .addStringOption(o => o.setName("title").setDescription("Short title (default: first words of the decision)").setRequired(false).setMaxLength(190))
      .addStringOption(o => o.setName("rationale").setDescription("Why").setRequired(false).setMaxLength(2000)),
    new SlashCommandBuilder().setName("freeze").setDescription("Freeze a project (agents stop working on it, merges are held) — or unfreeze it")
      .addIntegerOption(projectOpt)
      .addBooleanOption(o => o.setName("unfreeze").setDescription("Set true to unfreeze").setRequired(false)),
    new SlashCommandBuilder().setName("report-daily").setDescription("Generate the CEO executive digest now"),
    new SlashCommandBuilder().setName("claude-login").setDescription("Re-authenticate the Claude CLI used by all agents (sends you a private login link)"),
    new SlashCommandBuilder().setName("setup-channels").setDescription(`Create the team category and one channel per agent (if missing)`),
  ].map(c => c.toJSON());
}

const actorOf = (i: Interaction | Message): Actor => {
  const u = "user" in i ? i.user : i.author;
  return { id: u.id, tag: u.tag };
};

function isAuthorized(i: Interaction) {
  if (ALLOWED.size) return ALLOWED.has(i.user.id);
  return !!i.memberPermissions?.has(PermissionFlagsBits.Administrator);
}
const isAuthorizedMessage = (m: Message) =>
  ALLOWED.size ? ALLOWED.has(m.author.id) : !!m.member?.permissions.has(PermissionFlagsBits.Administrator);

const errText = (e: unknown) => (e instanceof ApiError ? `Backend: ${e.message}` : `Error: ${(e as Error).message}`);

/* ------------------------------------------------------------------ chat */

const chatError = (e: unknown) => `⚠️ ${e instanceof ApiError ? e.message : (e as Error).message}`.slice(0, 500);

const fileNote = (used: string[], skipped: string[]) =>
  `${used.length ? `-# 📎 Read: ${used.join(", ")}\n` : ""}${skipped.length ? `-# ⚠️ Skipped: ${skipped.join("; ")}\n` : ""}`;

/** Keeps "Devenum AI is typing…" visible every 8 s while Claude works (up to the 5-minute limit). */
function keepTyping(channel: { sendTyping: () => Promise<unknown> } | null) {
  if (!channel) return () => undefined;
  channel.sendTyping().catch(() => undefined);
  const t = setInterval(() => channel.sendTyping().catch(() => undefined), 8_000);
  return () => clearInterval(t);
}

async function onAsk(i: ChatInputCommandInteraction) {
  const prompt = i.options.getString("prompt", true);
  const files = ["file", "file2", "file3"].map(n => i.options.getAttachment(n)).filter((a): a is NonNullable<typeof a> => !!a);
  await i.deferReply();
  const stopTyping = keepTyping(i.channel && "sendTyping" in i.channel ? i.channel : null);
  try {
    const r = await chat(api, i.channelId, i.user.username, prompt, files);
    const parts = chunks(`> ${prompt.slice(0, 180).replace(/\n/g, " ")}${prompt.length > 180 ? "…" : ""}\n${fileNote(r.filesUsed, r.skipped)}\n${r.reply}`);
    await i.editReply({ content: parts[0], allowedMentions: { parse: [] } });
    for (const p of parts.slice(1)) await i.followUp({ content: p, allowedMentions: { parse: [] } });
    log("info", "ask answered", { user: i.user.tag, files: r.filesUsed.length, parts: parts.length });
  } catch (e) {
    await i.editReply(chatError(e));
  } finally {
    stopTyping();
  }
}

function planEmbed(plan: TeamPlan) {
  const proj = plan.project.existingProjectId ? `existing project #${plan.project.existingProjectId} **${plan.project.name}**` : `new project **${plan.project.name}** (${plan.project.category}${plan.project.techStack ? ` · ${plan.project.techStack}` : ""})`;
  return new EmbedBuilder().setColor(0xf59e0b).setTitle(`📋 Team plan #${plan.id}`)
    .setDescription(`${plan.summary ? `${plan.summary}\n\n` : ""}**Target:** ${proj}`.slice(0, 4000))
    .addFields(plan.tasks.slice(0, 10).map((t, n) => ({
      name: `${n + 1}. ${BADGE[t.agentSlug] ?? "🤖"} ${t.agentName} · ${t.priority}`.slice(0, 256),
      value: `**${t.title}**\n${t.description.replace(/\s+/g, " ").slice(0, 300)}${t.description.length > 300 ? "…" : ""}`.slice(0, 1024),
    })))
    .setFooter({ text: "Nothing is created until you approve. Tasks then run one at a time, and every code change still needs your Approve & Merge." });
}
const planButtons = (id: number, disabled = false) => new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(ids.make("pm_dispatch", id)).setLabel("Approve & Assign to Team").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(disabled),
  new ButtonBuilder().setCustomId(ids.make("pm_discard", id)).setLabel("Discard plan").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
);

const pinButton = (projectId: number) => new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(ids.make("pin_decision", projectId)).setLabel("Pin Decision").setEmoji("📌").setStyle(ButtonStyle.Secondary),
);
/** #proj-<slug> channels (and their task threads) imply a project; 0 = ask in the modal. */
const projectChannelIds = new Map<string, number>();
function projectIdForChannel(channel: GuildTextBasedChannel) {
  const id = channel.isThread() ? channel.parentId : channel.id;
  return (id && projectChannelIds.get(id)) || 0;
}

/** Runs one chat turn with `slug` and posts the answer in `channel` under that agent's own name and avatar. */
async function agentConversation(channel: GuildTextBasedChannel, slug: string, author: string, text: string, attachments: import("discord.js").Attachment[], quote?: string) {
  const agents = await getAgents();
  const agent = agents.find(a => a.slug === slug);
  if (!agent) throw new Error(`Unknown agent ${slug}`);
  const stopTyping = keepTyping(channel);
  try {
    const r = await chat(api, channel.id, author, text, attachments, slug);
    const parts = chunks(`${quote ? `> ${quote.slice(0, 180).replace(/\n/g, " ")}${quote.length > 180 ? "…" : ""}\n` : ""}${fileNote(r.filesUsed, r.skipped)}${r.reply}`);
    const projectHint = projectIdForChannel(channel);
    await sendAs(channel, agent, client.user!.id, { parts, ...(r.plan ? { embeds: [planEmbed(r.plan)], components: [planButtons(r.plan.id)] } : { components: [pinButton(projectHint)] }) });
    log("info", "agent replied", { agent: slug, channel: channel.id, files: r.filesUsed.length, parts: parts.length, planId: r.plan?.id ?? null });
  } finally {
    stopTyping();
  }
}

/**
 * Direct chat for allowed users. Routing: an @Agent / @Role shorthand (e.g. @PM, @Frontend) wins; otherwise the
 * channel's agent (#project-manager, #backend-engineering, …); otherwise the Executive Assistant for @Devenum AI
 * mentions and chat channels (#general / #chat). Messages starting with "/" or "!" are ignored.
 */
async function onMessage(m: Message) {
  if (m.author.bot || m.webhookId || !m.inGuild() || m.guildId !== GUILD_ID || !client.user) return;
  const raw = m.content.trim();
  if (raw.startsWith("/") || raw.startsWith("!")) return;
  const mentioned = m.mentions.users.has(client.user.id);
  const chName = "name" in m.channel ? String(m.channel.name).toLowerCase() : "";
  const inChatChannel = CHAT_CHANNELS.has(m.channelId) || (!!chName && CHAT_CHANNELS.has(chName));
  const chanSlug = chName ? channelAgent(chName, await getAgents().catch(() => [])) : undefined;
  let text = raw.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
  const addressed = text.includes("@") ? findAddressedAgent(text, await getAgents().catch(() => [])) : null;
  if (addressed) text = addressed.text;
  const slug = addressed?.slug ?? chanSlug ?? (mentioned || inChatChannel ? "executive-assistant" : undefined);
  if (!slug) return;
  if (!isAuthorizedMessage(m)) return;
  const attachments = [...m.attachments.values()];
  if (!text && !attachments.length) {
    if (mentioned || addressed) await m.reply("👋 Ask me anything — or attach a document (.md .txt .json .csv .pdf .docx) to analyse.");
    return;
  }
  try {
    await agentConversation(m.channel as GuildTextBasedChannel, slug, m.author.username, text, attachments);
  } catch (e) {
    await m.reply({ content: chatError(e), allowedMentions: { repliedUser: false, parse: [] } });
  }
}

async function onChatAgent(i: ChatInputCommandInteraction) {
  const slug = i.options.getString("agent", true);
  const prompt = i.options.getString("prompt", true);
  const file = i.options.getAttachment("file");
  const agent = (await getAgents()).find(a => a.slug === slug);
  if (!agent) return i.reply({ content: `❌ Unknown agent \`${slug}\` — pick one from the list.`, flags: MessageFlags.Ephemeral });
  if (!i.channel || !i.inGuild()) return i.reply({ content: "Use this in a server channel.", flags: MessageFlags.Ephemeral });
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.editReply(`${BADGE[slug] ?? "🤖"} Asking **${agent.name}**… the reply will appear in this channel.`);
  try {
    await agentConversation(i.channel as GuildTextBasedChannel, slug, i.user.username, prompt, file ? [file] : [], `${i.user.username}: ${prompt}`);
    await i.editReply(`✅ **${agent.name}** replied below.`);
  } catch (e) {
    await i.editReply(chatError(e));
  }
}

/* ------------------------------------------------------------------ project tools */

async function doGithubPush(projectId: number, visibility: "private" | "public", actor: Actor) {
  const r = await api.githubPush(projectId, visibility, actor);
  log("info", "github push", { projectId, url: r.url, created: r.created, private: r.isPrivate });
  const note = r.visibilityMismatch ? `\n⚠️ The repo already existed as **${r.isPrivate ? "private" : "public"}**; its visibility was left unchanged.` : "";
  return `✅ ${r.created ? "Created" : "Updated"} **${r.isPrivate ? "private" : "public"}** repo and pushed \`main\` for **${r.projectName}**:\n${r.url}${note}`;
}

function previewReply(p: PreviewInfo) {
  return {
    content: `🌐 **Live preview for ${p.projectName ?? p.slug}** (\`${p.kind}\`, port ${p.port}):\n${p.url}\n-# Served from the workspace's current checkout. Also available in the portal.`,
    components: [previewButtons(p.projectId, p.url)],
  };
}

/* ------------------------------------------------------------------ slash commands */

async function onCommand(i: ChatInputCommandInteraction) {
  if (i.commandName !== "status" && !isAuthorized(i)) {
    return i.reply({ content: "⛔ You are not allowed to use Devenum CEO commands.", flags: MessageFlags.Ephemeral });
  }
  if (i.commandName === "ask") return onAsk(i);
  if (i.commandName === "chat-agent") return onChatAgent(i);
  if (i.commandName === "claude-login") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const before = await authStatus();
      const s = await startLogin(i.user.tag);
      log("info", "claude login started", { by: i.user.tag, wasLoggedIn: before.loggedIn });
      await i.editReply({
        content: [`🔐 **Claude CLI re-login** (only you can see this)`, before.loggedIn ? `-# The CLI currently reports logged in as ${before.email ?? "?"}; continuing replaces that login.` : "",
          "1. Open the link below and sign in with the Claude account the agents should use.",
          "2. Copy the authorization code shown at the end.",
          "3. Click **Enter code** and paste it. The link expires in 10 minutes."].filter(Boolean).join("\n"),
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setLabel("Open login page").setStyle(ButtonStyle.Link).setURL(s.url),
          new ButtonBuilder().setCustomId(ids.make("claude_code", s.id)).setLabel("Enter code").setEmoji("🔑").setStyle(ButtonStyle.Primary),
        )],
      });
    } catch (e) { await i.editReply(`❌ ${errText(e)}`); }
    return;
  }
  if (i.commandName === "decide") {
    await i.deferReply();
    try {
      const decision = i.options.getString("decision", true);
      const title = i.options.getString("title") ?? decision.split(/\s+/).slice(0, 8).join(" ");
      const d = await api.pinDecision(i.options.getInteger("project_id", true), { title, decision, rationale: i.options.getString("rationale") ?? undefined }, actorOf(i));
      await i.editReply(`📌 Decision #${d.id} pinned to **${d.project.name}**: **${d.title}**\n> ${decision.slice(0, 1500)}\n-# Injected into every agent prompt for this project from now on.`);
    } catch (e) { await i.editReply(`❌ ${errText(e)}`); }
    return;
  }
  if (i.commandName === "freeze") {
    await i.deferReply();
    try {
      const unfreeze = i.options.getBoolean("unfreeze") ?? false;
      const r = await api.freeze(i.options.getInteger("project_id", true), !unfreeze, actorOf(i));
      await i.editReply(r.isFrozen ? `❄️ **${r.name}** is frozen — agents stop working on it (running jobs are cancelled and re-queued) and approved merges are held until you unfreeze.` : `🔥 **${r.name}** is unfrozen — work and merges resume.`);
    } catch (e) { await i.editReply(`❌ ${errText(e)}`); }
    return;
  }
  if (i.commandName === "report-daily") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try { const r = await api.dailyReport(actorOf(i)); await i.editReply(`📊 **${r.title}** generated — posting it to the reports channel now. Also saved in the portal under Reports.`); void poll(); }
    catch (e) { await i.editReply(`❌ ${errText(e)}`); }
    return;
  }
  if (i.commandName === "setup-channels") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      agentCache = null; // pick up agents added since the last refresh
      const r = await setupTeamChannels(i.guild!, TEAM_CATEGORY, await getAgents());
      await i.editReply([`**Team channels** (category "${r.category}")`, r.created.length ? `✅ Created: ${r.created.join(", ")}` : "", r.existing.length ? `• Already present: ${r.existing.join(", ")}` : "",
        r.errors.length ? `⚠️ ${r.errors.join("\n⚠️ ")}` : "", r.canWebhooks ? "🪪 Agent identities: webhooks enabled" : "⚠️ Bot lacks **Manage Webhooks** — agents will reply as the bot with a name header instead of their own avatar.",
        "", r.channels.map(t => `#${t.name} → ${BADGE[t.slug] ?? "🤖"} ${t.slug}`).join("\n"), "#general → ✨ executive-assistant"].filter(Boolean).join("\n").slice(0, 1990));
    } catch (e) { await i.editReply(`❌ ${errText(e)}`); }
    return;
  }
  const ephemeral = i.commandName === "approvals";
  await i.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  const actor = actorOf(i);
  try {
    switch (i.commandName) {
      case "project-create": {
        const p = await api.createProject({
          name: i.options.getString("name", true), category: i.options.getString("type", true), description: i.options.getString("description", true),
        }, actor);
        await i.editReply({ embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle(`✅ Project created: ${p.name}`)
          .addFields({ name: "Project ID", value: String(p.id), inline: true }, { name: "Slug", value: p.slug, inline: true }, { name: "Workspace", value: `\`${p.repoPath}\`` })
          .setFooter({ text: `Next: /auto-build project_id:${p.id}  or  /task-add project_id:${p.id}` })] });
        break;
      }
      case "task-add": {
        const t = await api.createTask({
          projectId: i.options.getInteger("project_id", true), title: i.options.getString("title", true),
          agentSlug: i.options.getString("agent_role", true), priority: i.options.getString("priority") ?? "MEDIUM",
          description: i.options.getString("description") ?? undefined,
        }, actor);
        await i.editReply({ embeds: [new EmbedBuilder().setColor(0x6366f1).setTitle(`🗂 Task #${t.id} queued`).setDescription(t.title)
          .addFields(
            { name: "Project", value: t.project.name, inline: true }, { name: "Agent", value: `${t.assignedAgent.name} (${t.assignedAgent.status})`, inline: true },
            { name: "Priority", value: t.priority, inline: true }, { name: "Status", value: t.status, inline: true },
          ).setFooter({ text: "devenum-worker will pick this up when the agent is available." })] });
        break;
      }
      case "status": {
        const embed = statusEmbed(await api.status());
        const live = await api.previews().catch(() => [] as PreviewInfo[]);
        if (live.length) embed.addFields({ name: "Live previews", value: live.map(p => `#${p.projectId} ${p.slug} → ${p.url}`).join("\n").slice(0, 1024) });
        await i.editReply({ embeds: [embed] });
        break;
      }
      case "approvals": {
        const rows = await api.pendingProposals();
        if (!rows.length) { await i.editReply("✅ No pending proposals."); break; }
        await i.editReply(`📥 **${rows.length}** pending proposal(s)${rows.length > 10 ? " — showing the oldest 10" : ""}:`);
        for (const p of rows.slice(0, 10)) {
          await i.followUp({ embeds: [proposalEmbed(p)], components: [decisionButtons(p.id)], flags: MessageFlags.Ephemeral });
        }
        break;
      }
      case "github-push": {
        await i.editReply("⏳ Pushing to GitHub…");
        await i.editReply(await doGithubPush(i.options.getInteger("project_id", true), i.options.getString("visibility", true) as "private" | "public", actor));
        break;
      }
      case "preview": {
        const p = await api.startPreview(i.options.getInteger("project_id", true), actor, msg => i.editReply(`⏳ ${msg}`));
        await i.editReply(previewReply(p));
        break;
      }
      case "preview-stop": {
        const id = i.options.getInteger("project_id", true);
        const r = await api.stopPreview(id, actor);
        await i.editReply(r.preview ? `⏹ Preview for **${r.preview.slug}** (port ${r.preview.port}) stopped.` : `ℹ️ No preview is running for project #${id}.`);
        break;
      }
      case "download": {
        const z = await api.download(i.options.getInteger("project_id", true), actor);
        await i.editReply({
          content: `📦 **${z.name}** — ${z.files} files, ${(z.data.length / 1024).toFixed(0)} KB (excludes node_modules, .git, .next, dist and real .env files).`,
          files: [new AttachmentBuilder(z.data, { name: z.name })],
        });
        break;
      }
      case "auto-build": {
        const goal = i.options.getString("goal", true);
        await i.editReply("🧠 The Project Manager is planning this with Claude Code… (up to ~3 min)");
        const r = await api.autoBuild(i.options.getInteger("project_id", true), goal, actor);
        await i.editReply({ content: "", embeds: [new EmbedBuilder().setColor(0xd97757).setTitle(`🏗 Auto-build queued for ${r.projectName}`)
          .setDescription(`**Goal:** ${goal.slice(0, 600)}\n\n${r.tasks.map((t, n) => `**${n + 1}. Task #${t.id}** · ${t.agent.name} · ${t.priority}\n${t.title}`).join("\n\n")}`.slice(0, 4000))
          .setFooter({ text: "Tasks run one at a time: each starts after the previous step's proposal is approved and merged." })] });
        break;
      }
      case "project-delete": {
        const id = i.options.getInteger("project_id", true);
        const p = await api.project(id);
        await i.editReply({
          content: `⚠️ **Delete project #${p.id} "${p.name}"?**\nThis stops its preview and live deploy, deletes all its tasks, proposals, runs and related audit events, and removes the workspace folder \`${p.repoPath}\`. **This cannot be undone.**`,
          components: [deleteConfirmButtons(p.id)],
        });
        break;
      }
      case "deploy": {
        const r = await api.deploy(i.options.getInteger("project_id", true), actor, msg => i.editReply(`⏳ ${msg}`));
        await i.editReply({ content: `🚀 **${r.projectName} is live** (\`${r.kind}\`, PM2 \`${r.name}\`, port ${r.port}):\n${r.url}\n-# Runs permanently and survives reboots. Make sure ports 5201–5299 are open in the firewall.`, components: [deployButtons(r.projectId, r.url)] });
        break;
      }
      case "system": {
        await i.editReply({ embeds: [systemEmbed(await api.system())], components: [systemButtons()] });
        break;
      }
      case "backup": {
        await i.editReply("⏳ Creating a full backup (database + workspaces)…");
        const r = await api.backup(actor, msg => i.editReply(`⏳ ${msg}`));
        await i.editReply(`✅ Backup **${r.name}** created (${(r.bytes / 1048576).toFixed(1)} MB).\nDownload it from the portal: **Settings → Backups**. It is not attached here because it contains the database and project secrets.`);
        break;
      }
      case "handoff": {
        const t = await api.handoff(i.options.getInteger("project_id", true), actor);
        await i.editReply({ embeds: [new EmbedBuilder().setColor(0x0ea5e9).setTitle(`📘 Hand-off task #${t.id} queued for ${t.project.name}`)
          .setDescription("Deliverables: `README.md`, `docs/SETUP.md`, `.env.example` — documentation only, no behaviour changes.")
          .addFields({ name: "Agent", value: t.assignedAgent.name, inline: true }, { name: "Priority", value: t.priority, inline: true })
          .setFooter({ text: "You'll get the proposal here for approval; then /download or /github-push." })] });
        break;
      }
    }
  } catch (e) {
    log("warn", "command failed", { command: i.commandName, error: (e as Error).message });
    await i.editReply({ content: `❌ ${errText(e)}`.slice(0, 1900), embeds: [], components: [], files: [] }).catch(() => undefined);
  }
}

async function onAutocomplete(i: AutocompleteInteraction) {
  if (i.commandName !== "task-add" && i.commandName !== "chat-agent") return;
  const q = i.options.getFocused().toLowerCase();
  const rows = await getAgents().catch(() => [] as AgentRow[]);
  await i.respond(rows
    .filter(a => !q || a.name.toLowerCase().includes(q) || a.slug.includes(q) || a.roleTitle.toLowerCase().includes(q))
    .slice(0, 25)
    .map(a => ({ name: `${a.name} — ${a.roleTitle} (${a.status.toLowerCase()})`.slice(0, 100), value: a.slug })));
}

/* ------------------------------------------------------------------ buttons & modals */

/** Marks a proposal message as decided and disables its buttons. */
async function markDecided(i: ButtonInteraction | ModalSubmitInteraction, id: number, text: string, color: number) {
  const base = i.message?.embeds[0] ? EmbedBuilder.from(i.message.embeds[0]) : new EmbedBuilder().setTitle(`Proposal #${id}`);
  const embed = base.setColor(color).addFields({ name: "Decision", value: text.slice(0, 1024) });
  if (i.isButton() || (i.isModalSubmit() && i.isFromMessage())) await i.update({ embeds: [embed], components: [decisionButtons(id, true)] });
  else await i.reply({ content: text, flags: MessageFlags.Ephemeral });
}

async function decisionError(i: ButtonInteraction | ModalSubmitInteraction, id: number, e: unknown) {
  const msg = errText(e);
  if (e instanceof ApiError && e.status === 409) await markDecided(i, id, `ℹ️ ${msg}`, 0x64748b);
  else await i.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
}

function feedbackModal(customId: string, title: string, label: string, required: boolean) {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("reason").setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(required).setMinLength(required ? 2 : 0).setMaxLength(1500),
    ),
  );
}

async function onButton(i: ButtonInteraction) {
  const parsed = ids.parse(i.customId);
  if (!parsed) return;
  if (!isAuthorized(i)) return i.reply({ content: "⛔ Only the CEO can use these buttons.", flags: MessageFlags.Ephemeral });
  const { action, id } = parsed;
  const actor = actorOf(i);

  switch (action) {
    case "approve":
      try {
        await api.approve(id, actor);
        log("info", "proposal approved", { proposalId: id, by: i.user.tag });
        await markDecided(i, id, `✅ Approved by <@${i.user.id}> — devenum-worker will merge the branch into main.`, 0x22c55e);
      } catch (e) { await decisionError(i, id, e); }
      return;
    case "reject":
      return i.showModal(feedbackModal(ids.make("rejectmodal", id), `Reject proposal #${id}`, "Reason", false));
    case "proposal_revise":
      return i.showModal(feedbackModal(ids.make("proposal_revise_modal", id), "Changes / Feedback", "What should the agent change?", true));
    case "gh_push_skip":
      await i.update({ components: [githubButtons(id, true)], content: `${i.message.content}\n⏭ Skipped by <@${i.user.id}>.` });
      return;
    case "gh_push_private":
    case "gh_push_public": {
      const visibility = action === "gh_push_private" ? "private" : "public";
      await i.update({ components: [githubButtons(id, true)], content: `${i.message.content}\n⏳ Pushing (${visibility}) — requested by <@${i.user.id}>…` });
      try {
        await i.followUp(await doGithubPush(id, visibility, actor));
      } catch (e) {
        await i.followUp(`❌ GitHub push failed: ${errText(e)}`.slice(0, 1900));
        await i.message.edit({ components: [githubButtons(id)] }).catch(() => undefined); // allow retry
      }
      return;
    }
    case "task_retry": {
      try {
        const t = await api.retryTask(id, actor);
        await i.update({ content: `${i.message.content}\n🔁 Re-queued by <@${i.user.id}> — task #${t.id} is READY and continues on its branch.`, components: [retryButton(id, true)] });
      } catch (e) { await i.reply({ content: `❌ ${errText(e)}`, flags: MessageFlags.Ephemeral }); }
      return;
    }
    case "project_delete_cancel":
      await i.update({ content: `${i.message.content}\n✋ Cancelled.`, components: [deleteConfirmButtons(id, true)] });
      return;
    case "project_delete_confirm": {
      await i.update({ content: `${i.message.content}\n⏳ Deleting…`, components: [deleteConfirmButtons(id, true)] });
      try {
        const r = await api.deleteProject(id, actor);
        await i.followUp(`🗑 **${r.name}** deleted — ${r.tasks} task(s), ${r.proposals} proposal(s)${r.workspaceRemoved ? ", workspace removed" : ""}.`);
      } catch (e) { await i.followUp(`❌ ${errText(e)}`.slice(0, 1900)); }
      return;
    }
    case "deploy_stop": {
      try {
        const r = await api.deployStop(id, actor);
        await i.update({ content: `${i.message.content}\n⏹ ${r.stopped ? `\`${r.name}\` stopped` : "Was not running"} (by <@${i.user.id}>).`, components: [] });
      } catch (e) { await i.reply({ content: `❌ ${errText(e)}`, flags: MessageFlags.Ephemeral }); }
      return;
    }
    case "sys_restart": {
      const name = CORE_SERVICES[id - 1];
      if (!name) return;
      try {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await api.restartService(name, actor);
        await i.editReply(`🔄 \`${r.name}\` is restarting${name === "devenum-bot" ? " — I'll be back in a few seconds" : ""}.`);
      } catch (e) { await i.editReply(`❌ ${errText(e)}`).catch(() => undefined); }
      return;
    }
    case "pm_dispatch": {
      await i.update({ components: [planButtons(id, true)] });
      try {
        const r = await api.dispatchPlan(id, actor);
        const pm = (await getAgents()).find(a => a.slug === "project-manager");
        const lines = r.tasks.map((t, n) => `${n + 1}. ${BADGE[t.agentSlug] ?? "🤖"} **${t.agent}** — task #${t.id}: ${t.title}`).join("\n");
        const msg = `✅ Approved by <@${i.user.id}>. Project **#${r.project.id} ${r.project.name}** — ${r.tasks.length} tasks assigned:\n${lines}\n\nStep 1 starts as soon as its agent is free; each next step starts after you approve & merge the previous one. Proposals will arrive in the approvals channel.`;
        if (pm && i.channel && i.inGuild()) await sendAs(i.channel as GuildTextBasedChannel, pm, client.user!.id, { parts: chunks(msg) });
        else await i.followUp(msg.slice(0, 1900));
        log("info", "team plan dispatched", { planId: id, projectId: r.project.id, tasks: r.tasks.length });
      } catch (e) {
        await i.followUp({ content: `❌ ${errText(e)}`, flags: MessageFlags.Ephemeral });
        if (!(e instanceof ApiError && e.status === 409)) await i.message.edit({ components: [planButtons(id)] }).catch(() => undefined);
      }
      return;
    }
    case "claude_code": {
      const modal = new ModalBuilder().setCustomId(ids.make("claude_code_modal", id)).setTitle("Claude CLI authorization code").addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("code").setLabel("Paste the code from the login page").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)),
      );
      return i.showModal(modal);
    }
    case "pin_decision": {
      const modal = new ModalBuilder().setCustomId(ids.make("pin_decision_modal", id)).setTitle("Pin as project decision").addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("project_id").setLabel("Project ID").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10).setValue(id ? String(id) : "")),
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("title").setLabel("Decision title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(190)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("decision").setLabel("Decision (edit to the canonical rule)").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)
          .setValue((i.message.content || "").replace(/^-# .*\n/gm, "").replace(/^\*\*.*\*\*\n/, "").trim().slice(0, 4000) || " ")),
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("rationale").setLabel("Rationale (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(2000)),
      );
      return i.showModal(modal);
    }
    case "pm_discard":
      try { await api.discardPlan(id, actor); await i.update({ components: [planButtons(id, true)], content: `${i.message.content ?? ""}\n🗑 Plan discarded by <@${i.user.id}>.`.slice(0, 2000) }); }
      catch (e) { await i.reply({ content: `❌ ${errText(e)}`, flags: MessageFlags.Ephemeral }); }
      return;
    case "preview_stop": {
      const r = await api.stopPreview(id, actor).catch(() => ({ stopped: false }));
      await i.update({ content: `${i.message.content}\n⏹ ${r.stopped ? "Preview stopped" : "Preview was not running"} (by <@${i.user.id}>).`, components: [] });
      return;
    }
  }
}

async function onModal(i: ModalSubmitInteraction) {
  const parsed = ids.parse(i.customId);
  if (!parsed) return;
  if (!isAuthorized(i)) return i.reply({ content: "⛔ Only the CEO can decide proposals.", flags: MessageFlags.Ephemeral });
  const reason = i.fields.getTextInputValue("reason").trim();
  const actor = actorOf(i);
  try {
    if (parsed.action === "rejectmodal") {
      await api.reject(parsed.id, actor, reason || undefined);
      log("info", "proposal rejected", { proposalId: parsed.id, by: i.user.tag });
      await markDecided(i, parsed.id, `❌ Rejected by <@${i.user.id}>${reason ? `: ${reason.slice(0, 900)}` : ""}`, 0xef4444);
    } else if (parsed.action === "claude_code_modal") {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const r = await submitCode(parsed.id, i.fields.getTextInputValue("code"));
        if (r.loggedIn) {
          await api.claudeAuthRecovered(actor).catch(() => undefined);
          log("info", "claude login completed", { by: i.user.tag, email: r.email });
          await i.editReply(`✅ Claude CLI is logged in${r.email ? ` as **${r.email}**` : ""}. Agents can work again — the worker resumes picking up tasks within a few seconds.`);
        } else await i.editReply(`❌ Login did not complete. ${r.detail ? `CLI said: ${r.detail}` : ""}\nRun /claude-login to try again.`);
      } catch (e) { await i.editReply(`❌ ${(e as Error).message}`); }
      return;
    } else if (parsed.action === "pin_decision_modal") {
      const pid = Number(i.fields.getTextInputValue("project_id").trim());
      if (!Number.isInteger(pid) || pid <= 0) return void (await i.reply({ content: "❌ Enter a valid project ID (see /status).", flags: MessageFlags.Ephemeral }));
      const d = await api.pinDecision(pid, { title: i.fields.getTextInputValue("title").trim(), decision: i.fields.getTextInputValue("decision").trim(), rationale: i.fields.getTextInputValue("rationale").trim() || undefined }, actor);
      await i.reply({ content: `📌 Pinned decision #${d.id} to **${d.project.name}**: **${d.title}** — agents will follow it on every task for this project.`, allowedMentions: { parse: [] } });
    } else if (parsed.action === "proposal_revise_modal") {
      const r = await api.revise(parsed.id, reason, actor);
      log("info", "changes requested", { proposalId: parsed.id, followUpTaskId: r.followUpTaskId, by: i.user.tag });
      await markDecided(i, parsed.id, `🔁 Changes requested by <@${i.user.id}> → follow-up **task #${r.followUpTaskId}** queued for the same agent.\n> ${reason.slice(0, 700)}`, 0x3b82f6);
    }
  } catch (e) { await decisionError(i, parsed.id, e); }
}

/* ------------------------------------------------------------------ pollers */

/** Posts generated executive reports to #executive-reports (or #general). */
async function postReports(guild: import("discord.js").Guild) {
  const reports = await api.unpostedReports();
  if (!reports.length) return;
  const chans = await guild.channels.fetch();
  const target = (chans.find(c => c?.type === 0 && c.name === "executive-reports") ?? chans.find(c => c?.type === 0 && c.name === "general")) as import("discord.js").TextChannel | undefined;
  if (!target) return;
  for (const r of reports) {
    for (const part of chunks(r.body.replace(/^# (.*)$/m, "## $1"))) await target.send({ content: part, allowedMentions: { parse: [] } });
    await api.markReportPosted(r.id);
    log("info", "report posted", { reportId: r.id, channel: target.name });
  }
}

let polling = false;
async function approvalChannel() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel?.isSendable()) throw new Error(`Channel ${CHANNEL_ID} not found or the bot cannot send messages there`);
  return channel;
}

function mergeCard(m: MergedProposal) {
  if (m.mergeStatus === "FAILED") {
    return { content: `⚠️ **Merge failed for \`${m.project.slug}\`** (proposal #${m.id}, \`${m.branchName}\`). The task is BLOCKED.\n\`\`\`\n${(m.mergeError ?? "").slice(0, 1500)}\n\`\`\`` };
  }
  const head = `✅ **Merge complete for \`${m.project.slug}\`** — ${m.task ? `task #${m.task.id} "${m.task.title}"` : `proposal #${m.id}`} merged into \`main\`${m.mergeCommit ? ` (\`${m.mergeCommit.slice(0, 8)}\`)` : ""}.`;
  if (!githubEnabled) return { content: `${head}\n-# Set GITHUB_TOKEN in backend/.env to enable one-click GitHub pushes.` };
  return {
    content: `${head}\n**Merge complete for ${m.project.slug}. Push to GitHub?**${m.project.githubRepoUrl ? `\n-# Current repo: ${m.project.githubRepoUrl}` : ""}`,
    components: [githubButtons(m.project.id)],
  };
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) {
      await syncProjects(guild, api, log).catch(e => log("warn", "project sync failed", { error: (e as Error).message }));
      const map = await api.projectChannels().catch(() => []);
      projectChannelIds.clear();
      for (const p of map) if (p.discordChannelId) projectChannelIds.set(p.discordChannelId, p.id);
      await postReports(guild).catch(e => log("warn", "report post failed", { error: (e as Error).message }));
    }
    const hb = await api.heartbeat(client.user?.tag ?? "devenum-bot");
    githubEnabled = hb.github;
    const [proposals, merges, timeouts] = await Promise.all([api.unnotifiedProposals(), api.unpromptedMerges(), api.timeoutAlerts()]);
    const authState = await api.claudeAuth().catch(() => null);
    const authNeedsPost = !!authState && ((!authState.ok && !authState.alertedAt) || (authState.ok && !!authState.alertedAt && !!authState.recoveredAt && !authState.recoveryNotifiedAt));
    if (!proposals.length && !merges.length && !timeouts.length && !authNeedsPost) return;
    const channel = await approvalChannel();
    for (const p of proposals) {
      const msg = await channel.send({ content: `🔔 **New proposal awaiting CEO approval** — ${p.riskLevel} risk`, embeds: [proposalEmbed(p)], components: [decisionButtons(p.id)] });
      await api.markNotified(p.id, msg.id);
      log("info", "proposal announced", { proposalId: p.id, messageId: msg.id });
    }
    // Claude CLI auth watchdog: one alert per incident, plus a recovery notice.
    const auth = authState;
    if (auth && !auth.ok && !auth.alertedAt) {
      await channel.send({ content: `🚨 **Claude CLI session expired! Run /claude-login to reconnect.**\nAgents cannot run until you re-authenticate — new tasks are on hold and affected tasks were re-queued.\n-# Detected ${auth.detectedAt ? `<t:${Math.floor(new Date(auth.detectedAt).getTime() / 1000)}:R>` : ""} via ${auth.source ?? "?"}: ${(auth.message ?? "").replace(/\s+/g, " ").slice(0, 200)}`, allowedMentions: { parse: [] } });
      await api.claudeAuthAlerted("failure");
      log("warn", "claude auth alert sent", { source: auth.source });
    } else if (auth && auth.ok && auth.alertedAt && auth.recoveredAt && !auth.recoveryNotifiedAt) {
      await channel.send("✅ **Claude CLI reconnected** — agents are back to work.");
      await api.claudeAuthAlerted("recovery");
    }
    for (const t of timeouts) {
      const task = t.task;
      await channel.send({
        content: `⏱ **Watchdog: run timed out** — ${t.agent.name}${task ? ` on task #${task.id} "${task.title}" (${task.project.name})` : ""}.\n${(t.errorMessage ?? "").slice(0, 300)}\nThe process was terminated, the agent is available again and partial work is kept on its branch.`,
        components: task ? [retryButton(task.id)] : [],
      });
      await api.markAlerted(t.id);
      log("info", "timeout alert sent", { runId: t.id, taskId: task?.id });
    }
    for (const m of merges) {
      await channel.send(mergeCard(m));
      await api.markGithubPrompted(m.id);
      log("info", "merge announced", { proposalId: m.id, project: m.project.slug, status: m.mergeStatus });
    }
  } catch (e) {
    log("warn", "poll failed", { error: (e as Error).message });
  } finally {
    polling = false;
  }
}

/* ------------------------------------------------------------------ client */

// MessageContent is privileged: it must be switched ON in the Developer Portal. If it isn't, we reconnect without it;
// @mentions still work (Discord always delivers content of messages that mention the bot), chat channels won't.
const FULL_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];
const FALLBACK_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
let client = new Client({ intents: FULL_INTENTS });
let pollTimer: NodeJS.Timeout | null = null;

function wire(c: Client) {
  c.once(Events.ClientReady, async ready => {
    log("info", "connected", {
      user: ready.user.tag, guildId: GUILD_ID, messageContent: ready.options.intents.has(GatewayIntentBits.MessageContent),
      chatChannels: [...CHAT_CHANNELS],
    });
    try {
      const body = buildCommands();
      await new REST().setToken(TOKEN).put(Routes.applicationGuildCommands(ready.user.id, GUILD_ID), { body });
      log("info", "slash commands registered", { count: body.length, commands: body.map(b => b.name) });
    } catch (e) {
      log("error", "command registration failed", { error: (e as Error).message });
    }
    const guild = ready.guilds.cache.get(GUILD_ID) ?? await ready.guilds.fetch(GUILD_ID).catch(() => null);
    // Sync agent channels now, then every 30 min so newly added agents get their channel without a restart.
    let lastSyncLog = "";
    const syncTeam = async () => {
      if (!guild) return;
      try {
        const r = await setupTeamChannels(guild, TEAM_CATEGORY, await getAgents());
        const sig = JSON.stringify([r.created, r.errors, r.canWebhooks]);
        if (r.created.length || sig !== lastSyncLog) log(r.errors.length ? "warn" : "info", "team channels", { agents: r.channels.length, created: r.created, existing: r.existing, errors: r.errors, webhooks: r.canWebhooks });
        lastSyncLog = sig;
      } catch (e) { log("warn", "team channel setup failed", { error: (e as Error).message }); }
    };
    setInterval(() => void syncTeam(), 30 * 60_000).unref();
    void syncTeam();
    void poll();
    if (!pollTimer) pollTimer = setInterval(() => void poll(), POLL_MS);
  });

  c.on(Events.MessageCreate, m => { onMessage(m).catch(e => log("error", "chat failed", { error: (e as Error).message })); });

  c.on(Events.InteractionCreate, async i => {
    try {
      if (i.isAutocomplete()) await onAutocomplete(i);
      else if (i.isChatInputCommand()) await onCommand(i);
      else if (i.isButton()) await onButton(i);
      else if (i.isModalSubmit()) await onModal(i);
    } catch (e) {
      log("error", "interaction failed", { error: (e as Error).message });
    }
  });
}
wire(client);

const shutdown = () => { client.destroy().finally(() => process.exit(0)); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.login(TOKEN).catch(async e => {
  const msg = (e as Error).message;
  if (/disallowed intents/i.test(msg)) {
    log("warn", "Message Content Intent is not enabled in the Discord Developer Portal (Bot → Privileged Gateway Intents). "
      + "Reconnecting without it: @mention chat still works, DISCORD_CHAT_CHANNELS free-chat is disabled.");
    await client.destroy().catch(() => undefined);
    client = new Client({ intents: FALLBACK_INTENTS });
    wire(client);
    return client.login(TOKEN).catch(e2 => { log("error", "login failed", { error: (e2 as Error).message }); process.exit(1); });
  }
  log("error", "login failed", { error: msg });
  process.exit(1);
});

