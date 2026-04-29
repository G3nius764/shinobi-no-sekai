// src/index.js — Ponto de entrada: inicia Bot + API + Cron
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const client = require('./bot/client');
const { startServer } = require('./api/server');
const { routeCommand } = require('./bot/commands/handlers');
const { Events } = require('discord.js');
const cron = require('node-cron');
const { syncAcademiaNinja } = require('./sync/syncRules');

// ── Ligar bot aos handlers ─────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    try {
      await routeCommand(interaction);
    } catch (err) {
      console.error('[INDEX] Erro no comando:', err);
      const msg = { content: '❌ Erro inesperado.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    }
  }
});

// ── Prefixo de comandos (! para fallback) ─────────────────────────────────
client.removeAllListeners(Events.MessageCreate);
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('!')) return;
  const [cmd, ...args] = message.content.slice(1).trim().split(/\s+/);

  // Comandos rápidos por prefixo (uso do mestre em chat)
  if (cmd === 'sync' && message.member?.permissions.has('Administrator')) {
    await syncAcademiaNinja(client);
    message.reply('✅ Sync concluído!');
  }
});

// ── Cron: re-sync das regras a cada N horas ───────────────────────────────
const syncHours = parseInt(process.env.RULES_SYNC_INTERVAL) || 6;
cron.schedule(`0 */${syncHours} * * *`, async () => {
  console.log(`\n[CRON] 🔄 Re-sincronizando regras da Academia Ninja...`);
  await syncAcademiaNinja(client);
});

// ── Iniciar tudo ──────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   🥷  SHINOBI NO SEKAI — Sistema          ║');
  console.log('╚══════════════════════════════════════════╝');

  // Verificar variáveis obrigatórias
  const required = ['DISCORD_TOKEN','DISCORD_CLIENT_ID','DISCORD_GUILD_ID','JWT_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.warn('\n⚠️  Variáveis faltando:', missing.join(', '));
    console.warn('   Bot Discord pode não funcionar corretamente.\n');
  }

  // Iniciar API REST
  startServer();

  // Conectar bot ao Discord
  await client.login(process.env.DISCORD_TOKEN);
}

main().catch(err => {
  console.error('❌ Falha ao iniciar:', err);
  process.exit(1);
});
