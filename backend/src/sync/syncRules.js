// src/sync/syncRules.js
// Lê todos os canais da categoria "Academia Ninja" e salva as regras no banco
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const pool = require('../db/pool');

/**
 * Sincroniza todos os canais da categoria Academia Ninja
 * Lê as mensagens, parseia regras e salva no banco
 */
async function syncAcademiaNinja(discordClient) {
  console.log('\n📚 [SYNC] Iniciando sincronização da Academia Ninja...');

  try {
    const guild = await discordClient.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const channels = await guild.channels.fetch();

    const categoryId = process.env.DISCORD_ACADEMIA_CATEGORY_ID;
    const academiaChannels = channels.filter(ch =>
      ch && ch.parentId === categoryId && ch.isTextBased()
    );

    if (academiaChannels.size === 0) {
      console.warn('[SYNC] ⚠️  Nenhum canal encontrado na categoria Academia Ninja.');
      console.warn('[SYNC]    Verifique DISCORD_ACADEMIA_CATEGORY_ID no .env');
      return;
    }

    console.log(`[SYNC] 📋 Encontrados ${academiaChannels.size} canais para sincronizar`);

    for (const [, channel] of academiaChannels) {
      await syncChannel(channel);
    }

    console.log('[SYNC] ✅ Sincronização concluída!');
    await notifyRulesLoaded(discordClient);

  } catch (err) {
    console.error('[SYNC] ❌ Erro na sincronização:', err.message);
  }
}

/**
 * Lê todas as mensagens de um canal e salva no banco
 */
async function syncChannel(channel) {
  try {
    console.log(`[SYNC]   📖 Lendo #${channel.name}...`);

    // Buscar todas as mensagens (até 500 por canal)
    let allMessages = [];
    let lastId = null;

    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;

      const batch = await channel.messages.fetch(options);
      if (batch.size === 0) break;

      allMessages = allMessages.concat([...batch.values()]);
      lastId = batch.last().id;

      if (batch.size < 100) break;
      if (allMessages.length >= 500) break;
    }

    // Ordenar por data (mais antigas primeiro)
    allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    // Concatenar conteúdo
    const fullContent = allMessages
      .filter(m => !m.author.bot || m.embeds.length > 0)
      .map(m => {
        let text = m.content || '';
        // Incluir embeds
        m.embeds.forEach(e => {
          if (e.title) text += `\n## ${e.title}`;
          if (e.description) text += `\n${e.description}`;
          e.fields?.forEach(f => text += `\n### ${f.name}\n${f.value}`);
        });
        return text;
      })
      .join('\n\n')
      .trim();

    if (!fullContent) {
      console.log(`[SYNC]   ⏭️  Canal #${channel.name} vazio, pulando.`);
      return;
    }

    // Parsear regras estruturadas
    const parsedData = parseRulesContent(channel.name, fullContent);

    // Salvar/atualizar no banco
    await pool.query(`
      INSERT INTO discord_rules (channel_id, channel_name, category, content, parsed_data, synced_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (channel_id) DO UPDATE
        SET content     = EXCLUDED.content,
            parsed_data = EXCLUDED.parsed_data,
            synced_at   = NOW(),
            updated_at  = NOW()
    `, [channel.id, channel.name, 'Academia Ninja', fullContent, JSON.stringify(parsedData)]);

    // Salvar itens específicos extraídos
    await saveExtractedData(parsedData, channel.name);

    console.log(`[SYNC]   ✅ #${channel.name} — ${allMessages.length} msgs, ${fullContent.length} chars`);

  } catch (err) {
    console.error(`[SYNC]   ❌ Erro no canal #${channel.name}:`, err.message);
  }
}

/**
 * Parseia o conteúdo bruto de um canal e extrai dados estruturados
 * baseando-se nos padrões comuns de canais de RPG do Discord
 */
function parseRulesContent(channelName, content) {
  const result = {
    channelType: detectChannelType(channelName),
    sections: [],
    jutsus: [],
    items: [],
    ranks: [],
    attributes: [],
    villages: [],
    clans: [],
    raw: content.substring(0, 5000) // primeiros 5000 chars para referência
  };

  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

  // ── Detectar seções (headers marcados com #, **, ══, etc.) ──
  let currentSection = null;
  let currentContent = [];

  lines.forEach(line => {
    const isHeader =
      /^#{1,3}\s/.test(line) ||
      /^\*\*[^*]+\*\*$/.test(line) ||
      /^[═══━━━─]{5,}/.test(line) ||
      /^〔.+〕$/.test(line) ||
      /^\[.+\]$/.test(line);

    if (isHeader) {
      if (currentSection) {
        result.sections.push({ title: currentSection, content: currentContent.join('\n') });
      }
      currentSection = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/[═━─\[\]〔〕]/g, '').trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  });
  if (currentSection) {
    result.sections.push({ title: currentSection, content: currentContent.join('\n') });
  }

  // ── Extrair Jutsus ──────────────────────────────────────────
  if (result.channelType === 'jutsus' || result.channelType === 'tecnicas') {
    result.jutsus = extractJutsus(content);
  }

  // ── Extrair Itens / Loja ────────────────────────────────────
  if (result.channelType === 'loja' || result.channelType === 'itens') {
    result.items = extractItems(content);
  }

  // ── Extrair Ranks ───────────────────────────────────────────
  if (result.channelType === 'ranks' || result.channelType === 'regras') {
    result.ranks = extractRanks(content);
    result.attributes = extractAttributes(content);
  }

  // ── Extrair Vilas ───────────────────────────────────────────
  if (result.channelType === 'vilas' || result.channelType === 'mundo') {
    result.villages = extractVillages(content);
  }

  // ── Extrair Clãs ────────────────────────────────────────────
  if (result.channelType === 'clas' || result.channelType === 'clans') {
    result.clans = extractClans(content);
  }

  return result;
}

function detectChannelType(name) {
  const n = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/jutsu|tecnica|habilidade/.test(n)) return 'jutsus';
  if (/loja|item|equipamento|arma/.test(n)) return 'loja';
  if (/rank|nivel|graduacao/.test(n)) return 'ranks';
  if (/atributo|status|ficha/.test(n)) return 'atributos';
  if (/vila|aldeia|village/.test(n)) return 'vilas';
  if (/cla|clan/.test(n)) return 'clas';
  if (/regra|sistema|mecanica/.test(n)) return 'regras';
  if (/missao|missão|quest/.test(n)) return 'missoes';
  return 'geral';
}

function extractJutsus(content) {
  const jutsus = [];
  // Padrão: Nome do Jutsu / Rank / Custo de Chakra / Dano
  // Suporta vários formatos de documentação
  const patterns = [
    /\*\*(.+?)\*\*[\s\S]*?(?:Rank|rank)[:\s]+([EDCBAS])/g,
    /Nome[:\s]+(.+?)[\n\r][\s\S]*?Rank[:\s]+([EDCBAS])/gi,
  ];

  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1].trim();
      const rank = match[2].trim().toUpperCase();
      if (name && rank && !jutsus.find(j => j.name === name)) {
        // Extrair custo de chakra
        const chakraMatch = content.substring(match.index, match.index + 500)
          .match(/[Cc]hakra[:\s]+(\d+)/);
        const dmgMatch = content.substring(match.index, match.index + 500)
          .match(/[Dd]ano[:\s]+(\d+)/);
        const typeMatch = content.substring(match.index, match.index + 300)
          .match(/(Ninjutsu|Taijutsu|Genjutsu|Fuinjutsu|Kenjutsu|Senjutsu)/i);

        jutsus.push({
          name,
          rank,
          chakra_cost: chakraMatch ? parseInt(chakraMatch[1]) : 0,
          damage: dmgMatch ? dmgMatch[1] : null,
          type: typeMatch ? typeMatch[1] : 'Ninjutsu',
        });
      }
    }
  });

  return jutsus;
}

function extractItems(content) {
  const items = [];
  const pricePattern = /(.+?)[:\s]+(\d+)\s*(?:ryo|Ryo|RYO)/g;
  let match;
  while ((match = pricePattern.exec(content)) !== null) {
    const name = match[1].replace(/\*\*/g, '').trim();
    const price = parseInt(match[2]);
    if (name.length > 2 && name.length < 100 && price > 0) {
      items.push({ name, price });
    }
  }
  return items;
}

function extractRanks(content) {
  const ranks = ['Acadêmico', 'Genin', 'Chunin', 'Jonin', 'ANBU', 'Kage'];
  const found = [];
  ranks.forEach(rank => {
    if (content.includes(rank)) {
      const idx = content.indexOf(rank);
      const snippet = content.substring(idx, idx + 300);
      found.push({ rank, description: snippet.split('\n')[0] });
    }
  });
  return found;
}

function extractAttributes(content) {
  const attrs = ['Força','Velocidade','Resistência','Selos','Ninjutsu','Genjutsu','Taijutsu','Inteligência'];
  const found = [];
  attrs.forEach(attr => {
    if (content.includes(attr)) found.push(attr);
  });
  return found;
}

function extractVillages(content) {
  const villages = [
    { name:'Vila da Folha', aliases:['Konoha','Konohagakure'] },
    { name:'Vila da Areia', aliases:['Suna','Sunagakure'] },
    { name:'Vila da Névoa', aliases:['Kiri','Kirigakure'] },
    { name:'Vila da Nuvem', aliases:['Kumo','Kumogakure'] },
    { name:'Vila da Pedra', aliases:['Iwa','Iwagakure'] },
  ];
  return villages.filter(v =>
    v.aliases.some(a => content.includes(a)) || content.includes(v.name)
  );
}

function extractClans(content) {
  const known = ['Uzumaki','Uchiha','Hyuga','Nara','Akimichi','Yamanaka',
    'Inuzuka','Aburame','Sarutobi','Senju','Hatake'];
  return known.filter(c => content.includes(c));
}

/**
 * Salva dados extraídos nas tabelas específicas
 */
async function saveExtractedData(parsedData, channelName) {
  try {
    // Salvar vilas
    for (const v of parsedData.villages || []) {
      await pool.query(`
        INSERT INTO villages (name) VALUES ($1)
        ON CONFLICT (name) DO NOTHING
      `, [v.name]);
    }

    // Salvar jutsus extraídos
    for (const j of parsedData.jutsus || []) {
      await pool.query(`
        INSERT INTO jutsus (name, rank, type, chakra_cost, damage, source_channel)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
      `, [j.name, j.rank, j.type, j.chakra_cost, j.damage, channelName]);
    }

    // Salvar itens extraídos
    for (const item of parsedData.items || []) {
      await pool.query(`
        INSERT INTO shop_items (name, price, source_channel)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
      `, [item.name, item.price, channelName]);
    }
  } catch (err) {
    // Erros de constraint são esperados (duplicatas), ignorar
    if (!err.message.includes('duplicate') && !err.message.includes('unique')) {
      console.error('[SYNC] Erro ao salvar dados extraídos:', err.message);
    }
  }
}

/**
 * Notifica no log que as regras foram carregadas
 */
async function notifyRulesLoaded(client) {
  const logChannelId = process.env.DISCORD_LOG_CHANNEL_ID;
  if (!logChannelId) return;
  const ch = client.channels.cache.get(logChannelId);
  if (!ch) return;

  const { rows } = await pool.query('SELECT COUNT(*) FROM discord_rules');

  ch.send({
    embeds: [{
      color: 0xC8921A,
      title: '📚 Academia Ninja Sincronizada',
      description: `${rows[0].count} canais de regras carregados com sucesso!`,
      footer: { text: 'Shinobi no Sekai · Sistema' },
      timestamp: new Date().toISOString(),
    }]
  }).catch(() => {});
}

/**
 * Busca regras por tipo de canal (para uso da API)
 */
async function getRulesByType(channelType) {
  const { rows } = await pool.query(`
    SELECT channel_name, content, parsed_data, synced_at
    FROM discord_rules
    WHERE parsed_data->>'channelType' = $1
       OR channel_name ILIKE '%' || $1 || '%'
    ORDER BY synced_at DESC
  `, [channelType]);
  return rows;
}

/**
 * Busca todas as regras (para o portal)
 */
async function getAllRules() {
  const { rows } = await pool.query(`
    SELECT channel_id, channel_name, category, parsed_data, synced_at
    FROM discord_rules
    ORDER BY channel_name
  `);
  return rows;
}

module.exports = { syncAcademiaNinja, getRulesByType, getAllRules };
