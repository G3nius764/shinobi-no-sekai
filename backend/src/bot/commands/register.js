// src/bot/commands/register.js — Registra todos os slash commands
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  // ── /registrar ──────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('registrar')
    .setDescription('Cria seu personagem no Shinobi no Sekai')
    .addStringOption(o => o.setName('nome').setDescription('Nome do seu personagem').setRequired(true))
    .addStringOption(o => o.setName('cla').setDescription('Clã do personagem').setRequired(false)),

  // ── /perfil ──────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('perfil')
    .setDescription('Exibe o perfil do seu personagem')
    .addUserOption(o => o.setName('jogador').setDescription('Ver perfil de outro jogador').setRequired(false)),

  // ── /status ──────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Atualiza HP, Chakra ou Stress do personagem')
    .addStringOption(o =>
      o.setName('tipo')
        .setDescription('Tipo de status')
        .setRequired(true)
        .addChoices(
          { name: '❤️ HP', value: 'hp' },
          { name: '🔵 Chakra', value: 'chakra' },
          { name: '⚠️ Stress', value: 'stress' }
        ))
    .addIntegerOption(o => o.setName('valor').setDescription('Novo valor').setRequired(true)),

  // ── /xp ──────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('xp')
    .setDescription('[GM] Adiciona XP a um jogador')
    .addUserOption(o => o.setName('jogador').setDescription('Jogador alvo').setRequired(true))
    .addIntegerOption(o => o.setName('quantidade').setDescription('Quantidade de XP').setRequired(true))
    .addStringOption(o => o.setName('motivo').setDescription('Motivo').setRequired(false)),

  // ── /ryo ─────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('ryo')
    .setDescription('[GM] Adiciona/Remove Ryo de um jogador')
    .addUserOption(o => o.setName('jogador').setDescription('Jogador alvo').setRequired(true))
    .addIntegerOption(o => o.setName('quantidade').setDescription('Valor (negativo para remover)').setRequired(true))
    .addStringOption(o => o.setName('motivo').setDescription('Motivo').setRequired(false)),

  // ── /missao ──────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('missao')
    .setDescription('[GM] Envia uma missão para um jogador')
    .addUserOption(o => o.setName('jogador').setDescription('Jogador alvo').setRequired(true))
    .addStringOption(o => o.setName('titulo').setDescription('Título da missão').setRequired(true))
    .addStringOption(o => o.setName('descricao').setDescription('Descrição da missão').setRequired(true))
    .addStringOption(o =>
      o.setName('tipo')
        .setDescription('Tipo de missão')
        .setRequired(true)
        .addChoices(
          { name: '⭐ Principal', value: 'main' },
          { name: '📌 Secundária', value: 'side' },
          { name: '🔥 Especial', value: 'special' }
        ))
    .addIntegerOption(o => o.setName('recompensa_ryo').setDescription('Ryo de recompensa').setRequired(false))
    .addIntegerOption(o => o.setName('recompensa_xp').setDescription('XP de recompensa').setRequired(false)),

  // ── /completar ───────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('completar')
    .setDescription('[GM] Marca uma missão como completa e distribui recompensas')
    .addUserOption(o => o.setName('jogador').setDescription('Jogador').setRequired(true))
    .addStringOption(o => o.setName('missao_id').setDescription('ID da missão').setRequired(true)),

  // ── /jutsu ───────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('jutsu')
    .setDescription('Ensina um jutsu ao seu personagem ou consulta um jutsu')
    .addSubcommand(s =>
      s.setName('aprender')
        .setDescription('Aprende um jutsu (requer aprovação do GM)')
        .addStringOption(o => o.setName('nome').setDescription('Nome do jutsu').setRequired(true)))
    .addSubcommand(s =>
      s.setName('info')
        .setDescription('Consulta informações de um jutsu')
        .addStringOption(o => o.setName('nome').setDescription('Nome do jutsu').setRequired(true))),

  // ── /sincronizar ─────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('sincronizar')
    .setDescription('[ADMIN] Re-sincroniza as regras da Academia Ninja'),

  // ── /regras ──────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('regras')
    .setDescription('Exibe um resumo das regras do sistema')
    .addStringOption(o =>
      o.setName('tema')
        .setDescription('Tema das regras')
        .setRequired(false)
        .addChoices(
          { name: '⚔️ Combate', value: 'combate' },
          { name: '📊 Atributos', value: 'atributos' },
          { name: '🥷 Jutsus', value: 'jutsus' },
          { name: '🏆 Ranks', value: 'ranks' },
          { name: '💰 Economia', value: 'economia' }
        )),

  // ── /portal ──────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('portal')
    .setDescription('Recebe o link e credenciais do Portal do Jogador'),

  // ── /inventario ──────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('inventario')
    .setDescription('Exibe seu inventário'),
].map(c => c.toJSON());

async function registerCommands(client) {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('[BOT] Registrando slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID
      ),
      { body: commands }
    );
    console.log(`[BOT] ✅ ${commands.length} comandos registrados!`);
  } catch (err) {
    console.error('[BOT] ❌ Erro ao registrar comandos:', err.message);
  }
}

module.exports = { registerCommands, commandList: commands };
