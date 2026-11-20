import path from "path";
import dotenv from "dotenv";
import {
  ActionRowBuilder, AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction, Client, EmbedBuilder, Events, GatewayIntentBits, Interaction, Message,
  MessageFlags, ModalBuilder, ModalSubmitInteraction, PermissionFlagsBits, REST, Routes, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { Actor, AgentRow, ApiError, BackendApi } from "./api";
import { chat, chunks } from "./chat";
import { decisionButtons, ids, proposalEmbed, statusEmbed } from "./ui";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

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
const ASSISTANT_SLUG = process.env.CHAT_AGENT_SLUG || "executive-assistant";

const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) =>
  console[level === "info" ? "log" : level](JSON.stringify({ ts: new Date().toISOString(), level, service: "devenum-bot", msg, ...extra }));

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

/** Agents are cached briefly so autocomplete and chat always reflect the database (new agents appear automatically). */
let agentCache: { at: number; rows: AgentRow[] } | null = null;
async function getAgents(): Promise<AgentRow[]> {
  if (!agentCache || Date.now() - agentCache.at > 60_000) agentCache = { at: Date.now(), rows: await api.agents() };
  return agentCache.rows;
}

function buildCommands() {
  return [
    new SlashCommandBuilder().setName("project-create").setDescription("Create a new Devenum AI project")
      .addStringOption(o => o.setName("name").setDescription("Project name").setRequired(true).setMinLength(2).setMaxLength(120))
      .addStringOption(o => o.setName("type").setDescription("Project type").setRequired(true)
        .addChoices({ name: "Web", value: "WEB" }, { name: "Mobile app", value: "MOBILE_APP" }, { name: "Game", value: "GAME" }))
      .addStringOption(o => o.setName("description").setDescription("What should be built").setRequired(true).setMaxLength(2000)),
    new SlashCommandBuilder().setName("task-add").setDescription("Add a READY task for an agent")
      .addIntegerOption(o => o.setName("project_id").setDescription("Project ID (see /status)").setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName("title").setDescription("Task title / instructions").setRequired(true).setMinLength(2).setMaxLength(200))
      .addStringOption(o => o.setName("agent_role").setDescription("Agent that should do the work (loaded live from the backend)").setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName("priority").setDescription("Priority (default MEDIUM)").setRequired(false)
        .addChoices(...PRIORITIES.map(p => ({ name: p, value: p }))))
      .addStringOption(o => o.setName("description").setDescription("Detailed requirements / acceptance criteria").setRequired(false).setMaxLength(4000)),
    new SlashCommandBuilder().setName("status").setDescription("Active projects, running agents and pending approvals"),
    new SlashCommandBuilder().setName("approvals").setDescription("List pending proposals with Approve / Reject buttons"),
    new SlashCommandBuilder().setName("ask").setDescription("Chat with the Executive Assistant (brainstorming, Q&A, planning)")
      .addStringOption(o => o.setName("prompt").setDescription("Your question or idea").setRequired(true).setMaxLength(4000)),
  ].map(c => c.toJSON());
}

const actorOf = (i: Interaction): Actor => ({ id: i.user.id, tag: i.user.tag });

function isAuthorized(i: Interaction) {
  if (ALLOWED.size) return ALLOWED.has(i.user.id);
  return !!i.memberPermissions?.has(PermissionFlagsBits.Administrator);
}
const isAuthorizedMessage = (m: Message) =>
  ALLOWED.size ? ALLOWED.has(m.author.id) : !!m.member?.permissions.has(PermissionFlagsBits.Administrator);

const errText = (e: unknown) => (e instanceof ApiError ? `Backend: ${e.message}` : `Error: ${(e as Error).message}`);

async function onCommand(i: ChatInputCommandInteraction) {
  if (i.commandName !== "status" && !isAuthorized(i)) {
    return i.reply({ content: "⛔ You are not allowed to use Devenum CEO commands.", flags: MessageFlags.Ephemeral });
  }
  if (i.commandName === "ask") return onAsk(i);
  const ephemeral = i.commandName === "approvals";
  await i.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  try {
    switch (i.commandName) {
      case "project-create": {
        const p = await api.createProject({
          name: i.options.getString("name", true), category: i.options.getString("type", true), description: i.options.getString("description", true),
        }, actorOf(i));
        await i.editReply({ embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle(`✅ Project created: ${p.name}`)
          .addFields({ name: "Project ID", value: String(p.id), inline: true }, { name: "Slug", value: p.slug, inline: true }, { name: "Workspace", value: `\`${p.repoPath}\`` })
          .setFooter({ text: `Next: /task-add project_id:${p.id}` })] });
        break;
      }
      case "task-add": {
        const t = await api.createTask({
          projectId: i.options.getInteger("project_id", true), title: i.options.getString("title", true),
          agentSlug: i.options.getString("agent_role", true), priority: i.options.getString("priority") ?? "MEDIUM",
          description: i.options.getString("description") ?? undefined,
        }, actorOf(i));
        await i.editReply({ embeds: [new EmbedBuilder().setColor(0x6366f1).setTitle(`🗂 Task #${t.id} queued`).setDescription(t.title)
          .addFields(
            { name: "Project", value: t.project.name, inline: true }, { name: "Agent", value: `${t.assignedAgent.name} (${t.assignedAgent.status})`, inline: true },
            { name: "Priority", value: t.priority, inline: true }, { name: "Status", value: t.status, inline: true },
          ).setFooter({ text: "devenum-worker will pick this up when the agent is available." })] });
        break;
      }
      case "status":
        await i.editReply({ embeds: [statusEmbed(await api.status())] });
        break;
      case "approvals": {
        const rows = await api.pendingProposals();
        if (!rows.length) { await i.editReply("✅ No pending proposals."); break; }
        await i.editReply(`📥 **${rows.length}** pending proposal(s)${rows.length > 10 ? " — showing the oldest 10" : ""}:`);
        for (const p of rows.slice(0, 10)) {
          await i.followUp({ embeds: [proposalEmbed(p)], components: [decisionButtons(p.id)], flags: MessageFlags.Ephemeral });
        }
        break;
      }
    }
  } catch (e) {
    log("warn", "command failed", { command: i.commandName, error: (e as Error).message });
    await i.editReply(`❌ ${errText(e)}`).catch(() => undefined);
  }
}

const BUSY = "⏳ I'm already handling a couple of conversations — try again in a moment.";
const failText = (r: { timedOut: boolean; text: string }) =>
  r.timedOut ? "⌛ That took longer than 60 seconds. Try a narrower question, or use `/task-add` for bigger jobs." : `❌ Claude Code error: ${r.text.slice(0, 300)}`;

async function onAsk(i: ChatInputCommandInteraction) {
  const prompt = i.options.getString("prompt", true);
  await i.deferReply();
  const assistant = (await getAgents().catch(() => [])).find(a => a.slug === ASSISTANT_SLUG);
  const r = await chat(i.channelId, i.user.username, prompt, assistant);
  if (!r) return void (await i.editReply(BUSY));
  if (!r.ok) return void (await i.editReply(failText(r)));
  const parts = chunks(`> ${prompt.slice(0, 180).replace(/\n/g, " ")}${prompt.length > 180 ? "…" : ""}\n\n${r.text}`);
  await i.editReply(parts[0]);
  for (const p of parts.slice(1)) await i.followUp(p);
  log("info", "ask answered", { user: i.user.tag, ms: r.ms });
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
    const assistant = (await getAgents().catch(() => [])).find(a => a.slug === ASSISTANT_SLUG);
    const r = await chat(m.channelId, m.author.username, text, assistant);
    if (!r) return void (await m.reply(BUSY));
    if (!r.ok) return void (await m.reply(failText(r)));
    const parts = chunks(r.text);
    await m.reply({ content: parts[0], allowedMentions: { repliedUser: false, parse: [] } });
    for (const p of parts.slice(1)) await m.channel.send({ content: p, allowedMentions: { parse: [] } });
    log("info", "chat answered", { user: m.author.tag, channel: m.channelId, ms: r.ms });
  } finally {
    clearInterval(typing);
  }
}

/** Marks the proposal message as decided and removes the active buttons. */
async function markDecided(i: ButtonInteraction | ModalSubmitInteraction, id: number, text: string, color: number) {
  const base = i.message?.embeds[0] ? EmbedBuilder.from(i.message.embeds[0]) : new EmbedBuilder().setTitle(`Proposal #${id}`);
  const embed = base.setColor(color).addFields({ name: "Decision", value: text });
  if (i.isButton() || (i.isModalSubmit() && i.isFromMessage())) await i.update({ embeds: [embed], components: [decisionButtons(id, true)] });
  else await i.reply({ content: text, flags: MessageFlags.Ephemeral });
}

async function onButton(i: ButtonInteraction) {
  const parsed = ids.parse(i.customId);
  if (!parsed) return;
  if (!isAuthorized(i)) return i.reply({ content: "⛔ Only the CEO can decide proposals.", flags: MessageFlags.Ephemeral });

  if (parsed.action === "reject") {
    // Ask for a reason; it is stored on the Approval and fed back to the agent on retry.
    const modal = new ModalBuilder().setCustomId(ids.rejectModal(parsed.id)).setTitle(`Reject proposal #${parsed.id}`).addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("reason").setLabel("Reason / requested changes").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500),
      ),
    );
    return i.showModal(modal);
  }
  if (parsed.action !== "approve") return;
  try {
    await api.approve(parsed.id, actorOf(i));
    log("info", "proposal approved", { proposalId: parsed.id, by: i.user.tag });
    await markDecided(i, parsed.id, `✅ Approved by <@${i.user.id}> — devenum-worker will merge the branch into main.`, 0x22c55e);
  } catch (e) {
    const msg = errText(e);
    if (e instanceof ApiError && e.status === 409) await markDecided(i, parsed.id, `ℹ️ ${msg}`, 0x64748b);
    else await i.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}

async function onModal(i: ModalSubmitInteraction) {
  const parsed = ids.parse(i.customId);
  if (!parsed || parsed.action !== "rejectmodal") return;
  if (!isAuthorized(i)) return i.reply({ content: "⛔ Only the CEO can decide proposals.", flags: MessageFlags.Ephemeral });
  const reason = i.fields.getTextInputValue("reason").trim();
  try {
    await api.reject(parsed.id, actorOf(i), reason || undefined);
    log("info", "proposal rejected", { proposalId: parsed.id, by: i.user.tag });
    await markDecided(i, parsed.id, `❌ Rejected by <@${i.user.id}>${reason ? `: ${reason.slice(0, 900)}` : ""}`, 0xef4444);
  } catch (e) {
    const msg = errText(e);
    if (e instanceof ApiError && e.status === 409) await markDecided(i, parsed.id, `ℹ️ ${msg}`, 0x64748b);
    else await i.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}

// MessageContent is privileged: it must be switched ON in the Developer Portal. If it isn't, we reconnect without it;
// @mentions still work (Discord always delivers content of messages that mention the bot), chat channels won't.
const FULL_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];
const FALLBACK_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
let client = new Client({ intents: FULL_INTENTS });

let polling = false;
async function pollProposals() {
  if (polling) return;
  polling = true;
  try {
    const rows = await api.unnotifiedProposals();
    if (!rows.length) return;
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel?.isSendable()) throw new Error(`Channel ${CHANNEL_ID} not found or the bot cannot send messages there`);
    for (const p of rows) {
      const msg = await channel.send({ content: `🔔 **New proposal awaiting CEO approval** — ${p.riskLevel} risk`, embeds: [proposalEmbed(p)], components: [decisionButtons(p.id)] });
      await api.markNotified(p.id, msg.id);
      log("info", "proposal announced", { proposalId: p.id, messageId: msg.id });
    }
  } catch (e) {
    log("warn", "proposal poll failed", { error: (e as Error).message });
  } finally {
    polling = false;
  }
}

let pollTimer: NodeJS.Timeout | null = null;
function wire(c: Client) {
c.once(Events.ClientReady, async c => {
  log("info", "connected", { user: c.user.tag, guildId: GUILD_ID, messageContent: c.options.intents.has(GatewayIntentBits.MessageContent), chatChannels: [...CHAT_CHANNELS] });
  try {
    const body = buildCommands();
    await new REST().setToken(TOKEN).put(Routes.applicationGuildCommands(c.user.id, GUILD_ID), { body });
    log("info", "slash commands registered", { count: body.length });
  } catch (e) {
    log("error", "command registration failed", { error: (e as Error).message });
  }
  void pollProposals();
  if (!pollTimer) pollTimer = setInterval(() => void pollProposals(), POLL_MS);
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
