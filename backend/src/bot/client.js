// src/bot/client.js — Discord Bot principal
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const {
  Client, GatewayIntentBits, Partials,
  Collection, Events, ActivityType
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.commands = new Collection();

// ── READY ──────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async (c) => {
  console.log(`\n🥷 [BOT] Conectado como ${c.user.tag}`);
  console.log(`📡 [BOT] Servidor: ${process.env.DISCORD_GUILD_ID}`);

  c.user.setPresence({
    activities: [{ name: '忍の世界 · Shinobi no Sekai', type: ActivityType.Playing }],
    status: 'online',
  });

  // Sincronizar regras da Academia Ninja ao iniciar
  const { syncAcademiaNinja } = require('../sync/syncRules');
  await syncAcademiaNinja(c);

  // Registrar slash commands
  const { registerCommands } = require('./commands/register');
  await registerCommands(c);
});

// ── MENSAGENS ──────────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // Prefixo ! para comandos rápidos (além dos slash commands)
  if (!message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd  = args.shift().toLowerCase();

  const handler = require('./prefixCommands');
  await handler(cmd, args, message);
});

// ── INTERAÇÕES (Slash Commands + Buttons) ────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction);
    } catch (err) {
      console.error('[BOT] Erro no comando:', err);
      const msg = { content: '❌ Erro ao executar comando.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    }
  }

  if (interaction.isButton()) {
    const { handleButton } = require('./buttonHandlers');
    await handleButton(interaction);
  }
});

// ── NOVO MEMBRO ───────────────────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  const logChannel = member.guild.channels.cache.get(process.env.DISCORD_LOG_CHANNEL_ID);
  if (logChannel) {
    logChannel.send({
      embeds: [{
        color: 0xC8921A,
        title: '🥷 Novo Shinobi chegou!',
        description: `**${member.user.username}** entrou no servidor.\nUse \`/registrar\` para criar seu personagem.`,
        thumbnail: { url: member.user.displayAvatarURL() },
        timestamp: new Date().toISOString(),
      }]
    });
  }
});

module.exports = client;
