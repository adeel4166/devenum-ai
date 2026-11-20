import path from "path";
import dotenv from "dotenv";
import {
  ActionRowBuilder, AttachmentBuilder, AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction, Client, EmbedBuilder, Events,
  GatewayIntentBits, Interaction, Message, MessageFlags, ModalBuilder, ModalSubmitInteraction, PermissionFlagsBits, REST, Routes,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { Actor, AgentRow, ApiError, BackendApi, MergedProposal, PreviewInfo } from "./api";
import { chat, chunks } from "./chat";
import { decisionButtons, githubButtons, ids, previewButtons, proposalEmbed, statusEmbed } from "./ui";

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
    new SlashCommandBuilder().setName("ask").setDescription("Chat with the Executive Assistant (brainstorming, Q&A, planning)")
      .addStringOption(o => o.setName("prompt").setDescription("Your question or idea").setRequired(true).setMaxLength(4000)),
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

async function onAsk(i: ChatInputCommandInteraction) {
  const prompt = i.options.getString("prompt", true);
  await i.deferReply();
  try {
    const reply = await chat(api, i.channelId, i.user.username, prompt);
    const parts = chunks(`> ${prompt.slice(0, 180).replace(/\n/g, " ")}${prompt.length > 180 ? "…" : ""}\n\n${reply}`);
    await i.editReply(parts[0]);
    for (const p of parts.slice(1)) await i.followUp(p);
    log("info", "ask answered", { user: i.user.tag });
  } catch (e) {
    await i.editReply(chatError(e));
  }
}

/** Direct chat: @mention the bot, or talk in a configured chat channel. Allowed users only. */
async function onMessage(m: Message) {
  if (m.author.bot || !m.inGuild() || m.guildId !== GUILD_ID || !client.user) return;
  const mentioned = m.mentions.users.has(client.user.id);
  const chName = "name" in m.channel ? String(m.channel.name).toLowerCase() : "";
  const inChatChannel = CHAT_CHANNELS.has(m.channelId) || (!!chName && CHAT_CHANNELS.has(chName));
  if (!mentioned && !inChatChannel) return;
  if (!isAuthorizedMessage(m)) return;
  const text = m.content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
  if (!text) return void (await m.reply("👋 Ask me anything — brainstorming, technical questions, planning, or prompt polishing."));

  await m.channel.sendTyping().catch(() => undefined);
  const typing = setInterval(() => m.channel.sendTyping().catch(() => undefined), 8_000);
  try {
    const parts = chunks(await chat(api, m.channelId, m.author.username, text));
    await m.reply({ content: parts[0], allowedMentions: { repliedUser: false, parse: [] } });
    for (const p of parts.slice(1)) await m.channel.send({ content: p, allowedMentions: { parse: [] } });
    log("info", "chat answered", { user: m.author.tag, channel: m.channelId });
  } catch (e) {
    await m.reply({ content: chatError(e), allowedMentions: { repliedUser: false, parse: [] } });
  } finally {
    clearInterval(typing);
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
  if (i.commandName !== "task-add") return;
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
    } else if (parsed.action === "proposal_revise_modal") {
      const r = await api.revise(parsed.id, reason, actor);
      log("info", "changes requested", { proposalId: parsed.id, followUpTaskId: r.followUpTaskId, by: i.user.tag });
      await markDecided(i, parsed.id, `🔁 Changes requested by <@${i.user.id}> → follow-up **task #${r.followUpTaskId}** queued for the same agent.\n> ${reason.slice(0, 700)}`, 0x3b82f6);
    }
  } catch (e) { await decisionError(i, parsed.id, e); }
}

/* ------------------------------------------------------------------ pollers */

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
    const hb = await api.heartbeat(client.user?.tag ?? "devenum-bot");
    githubEnabled = hb.github;
    const [proposals, merges] = await Promise.all([api.unnotifiedProposals(), api.unpromptedMerges()]);
    if (!proposals.length && !merges.length) return;
    const channel = await approvalChannel();
    for (const p of proposals) {
      const msg = await channel.send({ content: `🔔 **New proposal awaiting CEO approval** — ${p.riskLevel} risk`, embeds: [proposalEmbed(p)], components: [decisionButtons(p.id)] });
      await api.markNotified(p.id, msg.id);
      log("info", "proposal announced", { proposalId: p.id, messageId: msg.id });
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

