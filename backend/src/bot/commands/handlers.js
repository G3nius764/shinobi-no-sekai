// src/bot/commands/handlers.js — Handlers de todos os slash commands
const pool = require('../../db/pool');
const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const bcrypt = require('bcryptjs');

// ── Cores temáticas ────────────────────────────────────────────────────────
const COLORS = {
  gold:   0xC8921A,
  red:    0xCC2222,
  blue:   0x1A6AAA,
  green:  0x22AA44,
  purple: 0x6622AA,
  dark:   0x0D1520,
};

// ── Helper: buscar personagem pelo discord_id ──────────────────────────────
async function getCharByDiscordId(discordId) {
  const { rows } = await pool.query(`
    SELECT c.*, u.discord_id, u.username,
           cl.name AS clan_name, v.name AS village_name
    FROM characters c
    JOIN users u ON c.user_id = u.id
    LEFT JOIN clans cl ON c.clan_id = cl.id
    LEFT JOIN villages v ON c.village_id = v.id
    WHERE u.discord_id = $1 AND c.is_active = TRUE
    LIMIT 1
  `, [discordId]);
  return rows[0] || null;
}

// ── Helper: verificar se é GM ou Admin ────────────────────────────────────
async function isGM(discordId) {
  const { rows } = await pool.query(
    `SELECT role FROM users WHERE discord_id = $1`, [discordId]
  );
  return rows[0] && ['gm','admin'].includes(rows[0].role);
}

// ── Helper: embed padrão do sistema ───────────────────────────────────────
function baseEmbed(title, color = COLORS.gold) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setFooter({ text: '🥷 Shinobi no Sekai · Sistema' })
    .setTimestamp();
}

// ─────────────────────────────────────────────────────────────────────────
// /registrar
// ─────────────────────────────────────────────────────────────────────────
async function handleRegistrar(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const nome = interaction.options.getString('nome');
  const claInput = interaction.options.getString('cla') || null;
  const discordId = interaction.user.id;
  const discordUsername = interaction.user.username;

  // Verificar se já tem conta
  const existing = await pool.query(
    `SELECT id FROM users WHERE discord_id = $1`, [discordId]
  );
  if (existing.rows.length > 0) {
    return interaction.editReply({
      embeds: [baseEmbed('❌ Já Registrado', COLORS.red)
        .setDescription('Você já possui um personagem!\nUse `/perfil` para ver suas informações.')]
    });
  }

  // Gerar senha automática (discord_id + parte do nome)
  const rawPass = `ninja_${discordId.slice(-4)}`;
  const hash = await bcrypt.hash(rawPass, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Criar usuário
    const userRes = await client.query(`
      INSERT INTO users (username, password_hash, discord_id, discord_username)
      VALUES ($1, $2, $3, $4) RETURNING id
    `, [discordUsername, hash, discordId, discordUsername]);

    const userId = userRes.rows[0].id;

    // Buscar clã se fornecido
    let clanId = null;
    if (claInput) {
      const clanRes = await client.query(
        `SELECT id FROM clans WHERE name ILIKE $1 LIMIT 1`, [claInput]
      );
      clanId = clanRes.rows[0]?.id || null;
    }

    // Criar personagem
    await client.query(`
      INSERT INTO characters (user_id, name, clan_id, rank, level, xp, ryo,
        hp_current, hp_max, chakra_current, chakra_max,
        attr_forca, attr_velocidade, attr_resistencia, attr_selos,
        attr_ninjutsu, attr_genjutsu, attr_taijutsu, attr_inteligencia, attr_points_available)
      VALUES ($1,$2,$3,'Acadêmico',1,0,500,100,100,100,100,1,1,1,1,1,1,1,1,5)
    `, [userId, nome, clanId]);

    await client.query('COMMIT');

    const embed = baseEmbed('🥷 Registro Concluído!')
      .setDescription(`Bem-vindo ao mundo shinobi, **${nome}**!`)
      .addFields(
        { name: '👤 Personagem', value: nome, inline: true },
        { name: '🏆 Rank', value: 'Acadêmico', inline: true },
        { name: '⭐ Nível', value: '1', inline: true },
        { name: '🔑 Acesso ao Portal', value: `**Usuário:** \`${discordUsername}\`\n**Senha:** \`${rawPass}\``, inline: false },
        { name: '🌐 Portal', value: 'http://localhost:5500 (configure a URL no .env)', inline: false },
        { name: '⚠️ Importante', value: 'Guarde suas credenciais! Você pode alterar a senha no Portal.', inline: false }
      )
      .setThumbnail(interaction.user.displayAvatarURL());

    await interaction.editReply({ embeds: [embed] });

    // Notificar no canal público
    const publicEmbed = baseEmbed('🥷 Novo Shinobi!')
      .setDescription(`**${nome}** entrou para a Academia!\nBem-vindo ao **Shinobi no Sekai** 🍥`)
      .setThumbnail(interaction.user.displayAvatarURL());
    await interaction.channel.send({ embeds: [publicEmbed] });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[CMD/registrar]', err);
    await interaction.editReply({ content: `❌ Erro ao registrar: ${err.message}` });
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// /perfil
// ─────────────────────────────────────────────────────────────────────────
async function handlePerfil(interaction) {
  await interaction.deferReply();

  const targetUser = interaction.options.getUser('jogador') || interaction.user;
  const char = await getCharByDiscordId(targetUser.id);

  if (!char) {
    return interaction.editReply({
      embeds: [baseEmbed('❌ Personagem não encontrado', COLORS.red)
        .setDescription(`<@${targetUser.id}> ainda não possui personagem.\nUse \`/registrar\` para criar!`)]
    });
  }

  const hpBar  = makeBar(char.hp_current, char.hp_max, '🟥', 10);
  const chkBar = makeBar(char.chakra_current, char.chakra_max, '🟦', 10);
  const xpBar  = makeBar(char.xp, char.xp_next, '🟨', 10);
  const xpPct  = Math.round((char.xp / char.xp_next) * 100);

  const embed = baseEmbed(`🥷 ${char.name}`)
    .setThumbnail(char.portrait_url || targetUser.displayAvatarURL())
    .addFields(
      { name: '🏆 Rank',  value: char.rank,  inline: true },
      { name: '⭐ Nível', value: `${char.level}`, inline: true },
      { name: '💰 Ryo',  value: `${char.ryo.toLocaleString('pt-BR')}`, inline: true },
      { name: '🏘️ Vila',  value: char.village_name || 'Desconhecida', inline: true },
      { name: '🩸 Clã',   value: char.clan_name || 'Sem Clã', inline: true },
      { name: '📅 Idade', value: `${char.age} anos`, inline: true },
      { name: `❤️ HP  ${char.hp_current}/${char.hp_max}`, value: hpBar },
      { name: `🔵 Chakra  ${char.chakra_current}/${char.chakra_max}`, value: chkBar },
      { name: `⭐ XP  ${char.xp}/${char.xp_next} (${xpPct}%)`, value: xpBar },
    );

  await interaction.editReply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────
// /status
// ─────────────────────────────────────────────────────────────────────────
async function handleStatus(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const tipo  = interaction.options.getString('tipo');
  const valor = interaction.options.getInteger('valor');
  const char  = await getCharByDiscordId(interaction.user.id);

  if (!char) return interaction.editReply({ content: '❌ Você não tem personagem. Use `/registrar`.' });

  const colMap = { hp: 'hp_current', chakra: 'chakra_current', stress: 'stress' };
  const maxMap = { hp: char.hp_max, chakra: char.chakra_max, stress: 100 };
  const col    = colMap[tipo];
  const max    = maxMap[tipo];

  if (valor < 0 || valor > max) {
    return interaction.editReply({ content: `❌ Valor deve ser entre 0 e ${max}.` });
  }

  await pool.query(`UPDATE characters SET ${col} = $1 WHERE id = $2`, [valor, char.id]);

  const icons = { hp: '❤️', chakra: '🔵', stress: '⚠️' };
  const embed = baseEmbed(`${icons[tipo]} Status Atualizado!`, COLORS.green)
    .setDescription(`**${tipo.toUpperCase()}** de **${char.name}** atualizado para **${valor}/${max}**.`);

  await interaction.editReply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────
// /xp (GM)
// ─────────────────────────────────────────────────────────────────────────
async function handleXP(interaction) {
  await interaction.deferReply();

  if (!await isGM(interaction.user.id)) {
    return interaction.editReply({ content: '❌ Apenas GMs podem usar este comando.' });
  }

  const targetUser = interaction.options.getUser('jogador');
  const quantidade = interaction.options.getInteger('quantidade');
  const motivo     = interaction.options.getString('motivo') || 'Sem motivo especificado';

  const char = await getCharByDiscordId(targetUser.id);
  if (!char) return interaction.editReply({ content: `❌ <@${targetUser.id}> não tem personagem.` });

  const novoXP = char.xp + quantidade;
  let novoLevel = char.level;
  let novoXpNext = char.xp_next;
  let levelUp = false;

  // Cálculo de level up (XP necessário = nivel * 1000)
  let xpRestante = novoXP;
  while (xpRestante >= novoXpNext && novoLevel < 100) {
    xpRestante -= novoXpNext;
    novoLevel++;
    novoXpNext = novoLevel * 1000;
    levelUp = true;
  }

  // Pontos de atributo ao subir de nível
  const attrPoints = levelUp ? (novoLevel - char.level) * 2 : 0;

  await pool.query(`
    UPDATE characters
    SET xp = $1, level = $2, xp_next = $3,
        attr_points_available = attr_points_available + $4
    WHERE id = $5
  `, [xpRestante, novoLevel, novoXpNext, attrPoints, char.id]);

  const embed = baseEmbed(`⭐ XP Concedido!`, levelUp ? COLORS.purple : COLORS.gold)
    .setDescription(`**${quantidade} XP** adicionados a **${char.name}**`)
    .addFields(
      { name: '📝 Motivo', value: motivo },
      { name: '📊 XP Atual', value: `${xpRestante}/${novoXpNext}`, inline: true },
      { name: '⭐ Nível', value: `${novoLevel}`, inline: true },
    );

  if (levelUp) {
    embed.addFields({
      name: '🎉 LEVEL UP!',
      value: `${char.name} subiu para o **Nível ${novoLevel}**! +${attrPoints} pontos de atributo!`
    });
    await interaction.channel.send({
      content: `<@${targetUser.id}>`,
      embeds: [baseEmbed('🎉 LEVEL UP!', COLORS.purple)
        .setDescription(`**${char.name}** alcançou o **Nível ${novoLevel}**!\n+${attrPoints} pontos de atributo disponíveis!`)
        .setThumbnail(targetUser.displayAvatarURL())]
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────
// /ryo (GM)
// ─────────────────────────────────────────────────────────────────────────
async function handleRyo(interaction) {
  await interaction.deferReply();

  if (!await isGM(interaction.user.id)) {
    return interaction.editReply({ content: '❌ Apenas GMs podem usar este comando.' });
  }

  const targetUser = interaction.options.getUser('jogador');
  const quantidade = interaction.options.getInteger('quantidade');
  const motivo     = interaction.options.getString('motivo') || 'Sem motivo';

  const char = await getCharByDiscordId(targetUser.id);
  if (!char) return interaction.editReply({ content: `❌ <@${targetUser.id}> não tem personagem.` });

  const novoRyo = Math.max(0, char.ryo + quantidade);
  await pool.query(`UPDATE characters SET ryo = $1 WHERE id = $2`, [novoRyo, char.id]);

  // Log da transação
  await pool.query(`
    INSERT INTO ryo_transactions (character_id, amount, type, description)
    VALUES ($1, $2, $3, $4)
  `, [char.id, quantidade, quantidade > 0 ? 'reward' : 'penalty', motivo]);

  const icon = quantidade > 0 ? '💰' : '💸';
  const cor  = quantidade > 0 ? COLORS.gold : COLORS.red;
  const embed = baseEmbed(`${icon} Ryo ${quantidade > 0 ? 'Concedido' : 'Removido'}`, cor)
    .addFields(
      { name: '👤 Personagem', value: char.name, inline: true },
      { name: '💱 Valor',      value: `${quantidade > 0 ? '+' : ''}${quantidade} Ryo`, inline: true },
      { name: '💰 Saldo',      value: `${novoRyo.toLocaleString('pt-BR')} Ryo`, inline: true },
      { name: '📝 Motivo',     value: motivo }
    );

  await interaction.editReply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────
// /missao (GM)
// ─────────────────────────────────────────────────────────────────────────
async function handleMissao(interaction) {
  await interaction.deferReply();

  if (!await isGM(interaction.user.id)) {
    return interaction.editReply({ content: '❌ Apenas GMs podem usar este comando.' });
  }

  const targetUser     = interaction.options.getUser('jogador');
  const titulo         = interaction.options.getString('titulo');
  const descricao      = interaction.options.getString('descricao');
  const tipo           = interaction.options.getString('tipo');
  const recompensaRyo  = interaction.options.getInteger('recompensa_ryo') || 0;
  const recompensaXP   = interaction.options.getInteger('recompensa_xp') || 0;

  const char = await getCharByDiscordId(targetUser.id);
  if (!char) return interaction.editReply({ content: `❌ <@${targetUser.id}> não tem personagem.` });

  // Criar missão
  const missionRes = await pool.query(`
    INSERT INTO missions (title, description, type, reward_ryo, reward_xp, created_by)
    VALUES ($1, $2, $3, $4, $5, (SELECT id FROM users WHERE discord_id = $6))
    RETURNING id
  `, [titulo, descricao, tipo, recompensaRyo, recompensaXP, interaction.user.id]);

  const missionId = missionRes.rows[0].id;

  // Atribuir ao personagem
  await pool.query(`
    INSERT INTO character_missions (character_id, mission_id)
    VALUES ($1, $2)
  `, [char.id, missionId]);

  const typeIcons = { main: '⭐', side: '📌', special: '🔥' };
  const embed = baseEmbed(`${typeIcons[tipo]} Missão Enviada!`)
    .setDescription(`Missão enviada para **${char.name}**`)
    .addFields(
      { name: '📋 Título',    value: titulo },
      { name: '📝 Descrição', value: descricao },
      { name: '💰 Ryo',       value: `${recompensaRyo}`, inline: true },
      { name: '⭐ XP',        value: `${recompensaXP}`, inline: true },
      { name: '🆔 ID',        value: `\`${missionId}\``, inline: true },
    );

  await interaction.editReply({ embeds: [embed] });

  // DM para o jogador
  try {
    const dmEmbed = baseEmbed(`${typeIcons[tipo]} Nova Missão!`, COLORS.purple)
      .setDescription(`**${char.name}**, você recebeu uma nova missão!`)
      .addFields(
        { name: '📋 Título',    value: titulo },
        { name: '📝 Descrição', value: descricao },
        { name: '💰 Recompensa', value: `${recompensaRyo} Ryo | ${recompensaXP} XP` }
      );
    await targetUser.send({ embeds: [dmEmbed] });
  } catch { /* DMs fechadas */ }
}

// ─────────────────────────────────────────────────────────────────────────
// /completar (GM)
// ─────────────────────────────────────────────────────────────────────────
async function handleCompletar(interaction) {
  await interaction.deferReply();

  if (!await isGM(interaction.user.id)) {
    return interaction.editReply({ content: '❌ Apenas GMs podem usar este comando.' });
  }

  const targetUser = interaction.options.getUser('jogador');
  const missionId  = interaction.options.getString('missao_id');
  const char       = await getCharByDiscordId(targetUser.id);
  if (!char) return interaction.editReply({ content: `❌ Personagem não encontrado.` });

  const { rows: cmRows } = await pool.query(`
    SELECT cm.*, m.title, m.reward_ryo, m.reward_xp
    FROM character_missions cm JOIN missions m ON cm.mission_id = m.id
    WHERE cm.character_id = $1 AND cm.mission_id = $2 AND cm.status = 'active'
  `, [char.id, missionId]);

  if (!cmRows.length) return interaction.editReply({ content: '❌ Missão não encontrada ou já completa.' });
  const cm = cmRows[0];

  const client2 = await pool.connect();
  try {
    await client2.query('BEGIN');
    await client2.query(
      `UPDATE character_missions SET status='completed', progress=100, completed_at=NOW() WHERE id=$1`,
      [cm.id]
    );
    await client2.query(
      `UPDATE characters SET ryo = ryo + $1, xp = xp + $2 WHERE id = $3`,
      [cm.reward_ryo, cm.reward_xp, char.id]
    );
    await client2.query(
      `INSERT INTO ryo_transactions (character_id, amount, type, description) VALUES ($1,$2,'mission_reward',$3)`,
      [char.id, cm.reward_ryo, `Missão: ${cm.title}`]
    );
    await client2.query('COMMIT');

    const embed = baseEmbed('✅ Missão Completada!', COLORS.green)
      .addFields(
        { name: '📋 Missão',     value: cm.title },
        { name: '👤 Personagem', value: char.name, inline: true },
        { name: '💰 Ryo',        value: `+${cm.reward_ryo}`, inline: true },
        { name: '⭐ XP',         value: `+${cm.reward_xp}`, inline: true },
      );
    await interaction.editReply({ embeds: [embed] });

  } catch (err) {
    await client2.query('ROLLBACK');
    await interaction.editReply({ content: `❌ Erro: ${err.message}` });
  } finally {
    client2.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// /jutsu info
// ─────────────────────────────────────────────────────────────────────────
async function handleJutsuInfo(interaction) {
  await interaction.deferReply();
  const nome = interaction.options.getString('nome');

  const { rows } = await pool.query(
    `SELECT * FROM jutsus WHERE name ILIKE $1 OR name ILIKE '%'||$1||'%' LIMIT 1`,
    [nome]
  );

  if (!rows.length) {
    return interaction.editReply({
      embeds: [baseEmbed('❌ Jutsu não encontrado', COLORS.red)
        .setDescription(`"${nome}" não foi encontrado.\nVerifique as regras nos canais da Academia Ninja.`)]
    });
  }

  const j = rows[0];
  const rankColors = { E:0x888888, D:0x22AA22, C:0x2244CC, B:0xAA8822, A:0xCC2222, S:0xC8921A };

  const embed = baseEmbed(`🌀 ${j.name}`, rankColors[j.rank] || COLORS.gold)
    .addFields(
      { name: '⛩️ Nome JP', value: j.name_jp || '—', inline: true },
      { name: '🏆 Rank',   value: j.rank || '—', inline: true },
      { name: '📚 Tipo',   value: j.type || '—', inline: true },
      { name: '🔵 Chakra', value: `${j.chakra_cost}`, inline: true },
      { name: '💥 Dano',   value: j.damage || '—', inline: true },
      { name: '🎯 Alcance',value: j.range_type || '—', inline: true },
    );
  if (j.description) embed.setDescription(j.description);
  if (j.requirements) embed.addFields({ name: '📋 Requisitos', value: j.requirements });

  await interaction.editReply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────
// /regras
// ─────────────────────────────────────────────────────────────────────────
async function handleRegras(interaction) {
  await interaction.deferReply();
  const tema = interaction.options.getString('tema') || null;

  const { rows } = await pool.query(
    tema
      ? `SELECT channel_name, content FROM discord_rules
         WHERE channel_name ILIKE '%'||$1||'%' OR parsed_data->>'channelType' = $1
         ORDER BY channel_name LIMIT 3`
      : `SELECT channel_name, content FROM discord_rules ORDER BY channel_name`,
    tema ? [tema] : []
  );

  if (!rows.length) {
    return interaction.editReply({
      embeds: [baseEmbed('📚 Regras', COLORS.blue)
        .setDescription('Nenhuma regra sincronizada ainda.\nUm admin pode usar `/sincronizar` para carregar as regras.')]
    });
  }

  const embed = baseEmbed(`📚 Regras ${tema ? `· ${tema}` : ''}`, COLORS.blue);

  rows.slice(0, 3).forEach(r => {
    const snippet = r.content.substring(0, 300).replace(/\n{3,}/g, '\n\n');
    embed.addFields({ name: `#${r.channel_name}`, value: snippet + '…' });
  });

  embed.setDescription('📖 Regras completas disponíveis no Portal do Jogador e nos canais da Academia Ninja.');
  await interaction.editReply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────
// /sincronizar (Admin)
// ─────────────────────────────────────────────────────────────────────────
async function handleSincronizar(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const { rows: userRow } = await pool.query(
    `SELECT role FROM users WHERE discord_id = $1`, [interaction.user.id]
  );
  if (!userRow[0] || userRow[0].role !== 'admin') {
    return interaction.editReply({ content: '❌ Apenas admins podem sincronizar.' });
  }

  await interaction.editReply({ content: '📚 Sincronizando Academia Ninja...' });
  const { syncAcademiaNinja } = require('../../sync/syncRules');
  await syncAcademiaNinja(interaction.client);
  await interaction.editReply({ content: '✅ Sincronização concluída!' });
}

// ─────────────────────────────────────────────────────────────────────────
// /portal
// ─────────────────────────────────────────────────────────────────────────
async function handlePortal(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const char = await getCharByDiscordId(interaction.user.id);
  if (!char) {
    return interaction.editReply({ content: '❌ Use `/registrar` primeiro!' });
  }

  const embed = baseEmbed('🌐 Portal do Jogador')
    .setDescription('Acesse o portal para ver sua ficha completa, loja e missões!')
    .addFields(
      { name: '🔗 URL',      value: process.env.PORTAL_URL || 'http://localhost:5500' },
      { name: '👤 Usuário',  value: `\`${char.discord_username || interaction.user.username}\`` },
      { name: '🔑 Senha',    value: 'Use a senha definida no registro (ou altere no portal)' },
    );

  await interaction.editReply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────
// /inventario
// ─────────────────────────────────────────────────────────────────────────
async function handleInventario(interaction) {
  await interaction.deferReply();

  const char = await getCharByDiscordId(interaction.user.id);
  if (!char) return interaction.editReply({ content: '❌ Use `/registrar` primeiro!' });

  const { rows } = await pool.query(`
    SELECT si.icon, si.name, si.category, i.quantity
    FROM inventory i JOIN shop_items si ON i.item_id = si.id
    WHERE i.character_id = $1
    ORDER BY si.category, si.name
  `, [char.id]);

  const embed = baseEmbed(`🎒 Inventário de ${char.name}`);

  if (!rows.length) {
    embed.setDescription('Inventário vazio.\nVisite a Loja Shinobi no Portal para comprar itens!');
  } else {
    const grouped = {};
    rows.forEach(r => {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push(`${r.icon} **${r.name}** ×${r.quantity}`);
    });
    Object.entries(grouped).forEach(([cat, items]) => {
      const catIcons = { weapon:'⚔️', accessory:'🎒', consumable:'🧪', scroll:'📜' };
      embed.addFields({ name: `${catIcons[cat] || '📦'} ${cat}`, value: items.join('\n') });
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ── Helper: barra de progresso ─────────────────────────────────────────
function makeBar(cur, max, emoji, size = 10) {
  const pct  = Math.round((cur / max) * size);
  const full = emoji.repeat(pct);
  const empty = '⬛'.repeat(size - pct);
  return full + empty;
}

// ── Router principal ───────────────────────────────────────────────────
async function routeCommand(interaction) {
  const cmd = interaction.commandName;
  const sub = interaction.options.getSubcommand?.(false);

  if (cmd === 'registrar')   return handleRegistrar(interaction);
  if (cmd === 'perfil')      return handlePerfil(interaction);
  if (cmd === 'status')      return handleStatus(interaction);
  if (cmd === 'xp')          return handleXP(interaction);
  if (cmd === 'ryo')         return handleRyo(interaction);
  if (cmd === 'missao')      return handleMissao(interaction);
  if (cmd === 'completar')   return handleCompletar(interaction);
  if (cmd === 'regras')      return handleRegras(interaction);
  if (cmd === 'sincronizar') return handleSincronizar(interaction);
  if (cmd === 'portal')      return handlePortal(interaction);
  if (cmd === 'inventario')  return handleInventario(interaction);
  if (cmd === 'jutsu') {
    if (sub === 'info') return handleJutsuInfo(interaction);
  }
}

module.exports = { routeCommand };
