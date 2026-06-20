require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

// ─── Config ───────────────────────────────────────────────────────────────────

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;
const userSessions = new Map();

const PRODUCTOS = {
  vip:     { nombre: 'Acceso Grupo VIP',     precio: 10 },
  pack1:   { nombre: '10 Fotos + 5 Videos',  precio: 15 },
  pack2:   { nombre: '20 Fotos + 10 Videos', precio: 25 },
  sexting: { nombre: 'Sexting',              precioPor10min: 1.99 }, // precio dinámico
};

// Tarifa y opciones de sexting
const SEXTING_PRECIO_POR_10MIN = 1.99;
const SEXTING_OPCIONES_MIN     = [10, 20, 30, 40, 50, 60];

/** Calcula el precio de sexting dado un número de minutos. */
const calcularPrecioSexting = (minutos) =>
  parseFloat(((minutos / 10) * SEXTING_PRECIO_POR_10MIN).toFixed(2));

const CRYPTO_CONFIG = {
  BTC:  { nombre: 'Bitcoin',   red: 'Bitcoin',     wallet: process.env.WALLET_BTC,  geckoId: 'bitcoin',  decimales: 8 },
  ETH:  { nombre: 'Ethereum',  red: 'ERC20',       wallet: process.env.WALLET_ETH,  geckoId: 'ethereum', decimales: 8 },
  SOL:  { nombre: 'Solana',    red: 'Solana',      wallet: process.env.WALLET_SOL,  geckoId: 'solana',   decimales: 4 },
  USDT: { nombre: 'Tether',    red: 'TRC20',       wallet: process.env.WALLET_USDT, geckoId: 'tether',   decimales: 2 },
  USDC: { nombre: 'USD Coin',  red: 'SPL/Polygon', wallet: process.env.WALLET_USDC, geckoId: 'usd-coin', decimales: 2 },
};

// ─── Teclados ─────────────────────────────────────────────────────────────────

const teclado = {
  productos: Markup.inlineKeyboard([
    [Markup.button.callback('💎 Grupo VIP',     'prod_vip')],
    [Markup.button.callback('📸 Pack 10F+5V',   'prod_pack1')],
    [Markup.button.callback('📸 Pack 20F+10V',  'prod_pack2')],
    [Markup.button.callback('🔥 Sexting',        'prod_sexting')],
  ]),
  minutosSexting: Markup.inlineKeyboard([
    [
      Markup.button.callback('🔥 10 min — $1.99',  'sexting_min_10'),
      Markup.button.callback('🔥 20 min — $3.98',  'sexting_min_20'),
      Markup.button.callback('🔥 30 min — $5.97',  'sexting_min_30'),
    ],
    [
      Markup.button.callback('🔥 40 min — $7.96',  'sexting_min_40'),
      Markup.button.callback('🔥 50 min — $9.95',  'sexting_min_50'),
      Markup.button.callback('🔥 60 min — $11.94', 'sexting_min_60'),
    ],
  ]),
  metodoPago: Markup.inlineKeyboard([
    [Markup.button.callback('💳 SPEI',   'pay_spei_data')],
    [Markup.button.callback('💎 Crypto', 'pay_crypto_select')],
  ]),
  monedas: Markup.inlineKeyboard([
    [Markup.button.callback('BTC',  'coin_BTC'),  Markup.button.callback('ETH',  'coin_ETH') ],
    [Markup.button.callback('SOL',  'coin_SOL'),  Markup.button.callback('USDT', 'coin_USDT')],
    [Markup.button.callback('USDC', 'coin_USDC')],
  ]),
};

// ─── Helpers generales ────────────────────────────────────────────────────────

/** Devuelve la sesión del usuario, creándola vacía si no existe. */
const getSession = (userId) => {
  if (!userSessions.has(userId)) userSessions.set(userId, {});
  return userSessions.get(userId);
};

/** Convierte USD a crypto usando CoinGecko. Lanza error si falla. */
const convertirACrypto = async (moneda, usd) => {
  const { geckoId, decimales } = CRYPTO_CONFIG[moneda];
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd`);
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json();
  const precioUsd = data[geckoId]?.usd;
  if (!precioUsd) throw new Error('Precio no disponible');
  return (usd / precioUsd).toFixed(decimales);
};

/** Obtiene el tipo de cambio USD → MXN. Sin key, gratis. */
const obtenerTipoCambioMXN = async () => {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  if (!res.ok) throw new Error(`ExchangeRate HTTP ${res.status}`);
  const data = await res.json();
  const tasa = data.rates?.MXN;
  if (!tasa) throw new Error('Tasa MXN no disponible');
  return tasa;
};

/** Lógica compartida al seleccionar un producto: guarda sesión y muestra precio + métodos de pago. */
const seleccionarProducto = async (ctx, prodId) => {
  const session = getSession(ctx.from.id);
  session.producto = prodId;

  // Sexting: primero pedir tiempo, el precio se calcula después
  if (prodId === 'sexting') {
    session.estado = 'ELIGIENDO_MINUTOS';
    return ctx.reply(
      `🔥 *Sexting*\n\n` +
      `💵 Tarifa: *$${SEXTING_PRECIO_POR_10MIN} USD* por cada 10 minutos\n\n` +
      `¿Cuánto tiempo quieres?`,
      { parse_mode: 'Markdown', ...teclado.minutosSexting }
    );
  }

  const producto  = PRODUCTOS[prodId];
  const precioUsd = producto?.precio ?? 0;

  let lineaPrecio = `💵 Precio: *$${precioUsd} USD*`;
  try {
    const tasa      = await obtenerTipoCambioMXN();
    const precioMxn = (precioUsd * tasa).toFixed(2);
    lineaPrecio     = `💵 Precio: *$${precioUsd} USD* (~$${precioMxn} MXN)`;
    session.tasaMxn = tasa;
  } catch (err) {
    console.error('ExchangeRate error:', err.message);
  }

  ctx.reply(
    `🛍 *${producto?.nombre}*\n` +
    `${lineaPrecio}\n\n` +
    `Selecciona método de pago:`,
    { parse_mode: 'Markdown', ...teclado.metodoPago }
  );
};

/** Devuelve el precio efectivo de la sesión (normal o sexting dinámico). */
const getPrecio = (session) =>
  session.producto === 'sexting'
    ? session.sextingPrecio
    : PRODUCTOS[session.producto]?.precio ?? 0;

/** Devuelve el nombre de producto con minutos si es sexting. */
const getNombre = (session) =>
  session.producto === 'sexting'
    ? `Sexting ${session.sextingMin} min`
    : PRODUCTOS[session.producto]?.nombre ?? session.producto;

/** Construye los botones de aprobar/rechazar para el admin. */
const botonesAdmin = (userId) => Markup.inlineKeyboard([
  [
    Markup.button.callback('✅ Aprobar',  `admin_aprobar_${userId}`),
    Markup.button.callback('❌ Rechazar', `admin_rechazar_${userId}`),
  ],
]);

// ─── Verificación SPEI (Conekta) ─────────────────────────────────────────────

const verificarSPEI = async (montoUsd) => {
  const apiKey = process.env.CONEKTA_API_KEY;
  if (!apiKey) return null; // desactivado → revisión manual

  const res = await fetch('https://api.conekta.io/orders?limit=20', {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.conekta-v2.2.0+json',
    },
  });
  if (!res.ok) throw new Error(`Conekta HTTP ${res.status}`);

  const data          = await res.json();
  const hace1hora     = Math.floor(Date.now() / 1000) - 3600;
  const montoCentavos = montoUsd * 100;

  return data.data?.some(order =>
    order.payment_status === 'paid' &&
    order.amount          === montoCentavos &&
    order.created_at      >= hace1hora &&
    order.charges?.data?.some(c => c.payment_method?.type === 'spei')
  ) ?? false;
};

// ─── Verificación Crypto (por blockchain) ────────────────────────────────────

const CONFIRMACIONES_MIN = { BTC: 2, ETH: 12, SOL: 1, USDT: 20, USDC: 12 };
const TOLERANCIA = 0.98; // acepta hasta 2% menos por fees de red

const resultado = (ok, detalle) => ({ ok, detalle });

/** BTC — Blockstream (sin API key) */
const verificarBTC = async (txid, wallet, montoEsperado) => {
  const res = await fetch(`https://blockstream.info/api/tx/${txid}`);
  if (!res.ok) throw new Error(`Blockstream HTTP ${res.status}`);
  const tx = await res.json();

  const confirmaciones = tx.status?.block_height
    ? await fetch('https://blockstream.info/api/blocks/tip/height')
        .then(r => r.json())
        .then(tip => tip - tx.status.block_height + 1)
    : 0;

  if (confirmaciones < CONFIRMACIONES_MIN.BTC)
    return resultado(false, `Solo ${confirmaciones}/${CONFIRMACIONES_MIN.BTC} confirmaciones BTC`);

  const output = tx.vout?.find(o => o.scriptpubkey_address === wallet);
  if (!output)
    return resultado(false, `El destino no coincide con tu wallet BTC`);

  const satoshisEsperados = Math.round(montoEsperado * 1e8);
  if (output.value < satoshisEsperados * TOLERANCIA)
    return resultado(false, `Monto insuficiente: ${output.value / 1e8} BTC (esperado ≥${montoEsperado} BTC)`);

  return resultado(true, `${output.value / 1e8} BTC confirmados en ${confirmaciones} bloques`);
};

/** ETH — Etherscan */
const verificarETH = async (txid, wallet, montoEsperado) => {
  const apiKey = process.env.ETHERSCAN_API_KEY ?? '';

  const [resRecibo, resTx] = await Promise.all([
    fetch(`https://api.etherscan.io/api?module=transaction&action=gettxreceiptstatus&txhash=${txid}&apikey=${apiKey}`),
    fetch(`https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=${txid}&apikey=${apiKey}`),
  ]);
  if (!resRecibo.ok || !resTx.ok) throw new Error('Etherscan HTTP error');

  const recibo = await resRecibo.json();
  const tx     = (await resTx.json()).result;

  if (recibo.result?.status !== '1')
    return resultado(false, `Transacción ETH fallida o pendiente`);
  if (tx?.to?.toLowerCase() !== wallet.toLowerCase())
    return resultado(false, `El destino no coincide con tu wallet ETH`);

  const resBloque      = await fetch(`https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${apiKey}`);
  const confirmaciones = parseInt((await resBloque.json()).result, 16) - parseInt(tx.blockNumber, 16);

  if (confirmaciones < CONFIRMACIONES_MIN.ETH)
    return resultado(false, `Solo ${confirmaciones}/${CONFIRMACIONES_MIN.ETH} confirmaciones ETH`);

  const valorEth = parseInt(tx.value, 16) / 1e18;
  if (valorEth < montoEsperado * TOLERANCIA)
    return resultado(false, `Monto insuficiente: ${valorEth.toFixed(6)} ETH (esperado ≥${montoEsperado} ETH)`);

  return resultado(true, `${valorEth.toFixed(6)} ETH confirmados (${confirmaciones} bloques)`);
};

/** SOL — Solscan */
const verificarSOL = async (txid, wallet, montoEsperado) => {
  const res = await fetch(`https://public-api.solscan.io/transaction/${txid}`);
  if (!res.ok) throw new Error(`Solscan HTTP ${res.status}`);
  const tx = await res.json();

  if (tx.status !== 'Success')
    return resultado(false, `Transacción SOL no confirmada (estado: ${tx.status})`);

  const transferencia =
    tx.innerInstructions?.flatMap(i => i.instructions ?? [])
      .find(i => i.parsed?.info?.destination === wallet) ??
    tx.tokenTransfers?.find(t => t.destinationOwner === wallet);

  if (!transferencia)
    return resultado(false, `El destino no coincide con tu wallet SOL`);

  const solRecibido = (transferencia.parsed?.info?.lamports ?? transferencia.amount * 1e9) / 1e9;
  if (solRecibido < montoEsperado * TOLERANCIA)
    return resultado(false, `Monto insuficiente: ${solRecibido.toFixed(4)} SOL (esperado ≥${montoEsperado} SOL)`);

  return resultado(true, `${solRecibido.toFixed(4)} SOL confirmados`);
};

/** USDT TRC20 — TronScan */
const verificarUSDT = async (txid, wallet, montoEsperado) => {
  const res = await fetch(`https://apilist.tronscanapi.com/api/transaction-info?hash=${txid}`);
  if (!res.ok) throw new Error(`TronScan HTTP ${res.status}`);
  const tx = await res.json();

  if (tx.contractRet !== 'SUCCESS')
    return resultado(false, `Transacción USDT fallida (${tx.contractRet})`);
  if (tx.toAddress?.toLowerCase() !== wallet.toLowerCase())
    return resultado(false, `El destino no coincide con tu wallet USDT TRC20`);
  if ((tx.confirmations ?? 0) < CONFIRMACIONES_MIN.USDT)
    return resultado(false, `Solo ${tx.confirmations}/${CONFIRMACIONES_MIN.USDT} confirmaciones USDT`);

  const monto = (tx.trigger_info?.parameter?._value ?? tx.amount ?? 0) / 1e6;
  if (monto < montoEsperado * TOLERANCIA)
    return resultado(false, `Monto insuficiente: ${monto.toFixed(2)} USDT (esperado ≥${montoEsperado} USDT)`);

  return resultado(true, `${monto.toFixed(2)} USDT confirmados en TRC20 (${tx.confirmations} confirmaciones)`);
};

/** USDC ERC20 — Etherscan (contrato oficial USDC) */
const verificarUSDC = async (txid, wallet, montoEsperado) => {
  const apiKey        = process.env.ETHERSCAN_API_KEY ?? '';
  const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

  const res  = await fetch(`https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=${USDC_CONTRACT}&address=${wallet}&txhash=${txid}&apikey=${apiKey}`);
  if (!res.ok) throw new Error(`Etherscan USDC HTTP ${res.status}`);
  const data = await res.json();

  const transfer = data.result?.find(t =>
    t.hash.toLowerCase() === txid.toLowerCase() &&
    t.to.toLowerCase()   === wallet.toLowerCase()
  );

  if (!transfer)
    return resultado(false, `No se encontró transferencia USDC a tu wallet en esa tx`);

  const confirmaciones = parseInt(transfer.confirmations ?? 0);
  if (confirmaciones < CONFIRMACIONES_MIN.USDC)
    return resultado(false, `Solo ${confirmaciones}/${CONFIRMACIONES_MIN.USDC} confirmaciones USDC`);

  const monto = parseInt(transfer.value) / 1e6;
  if (monto < montoEsperado * TOLERANCIA)
    return resultado(false, `Monto insuficiente: ${monto.toFixed(2)} USDC (esperado ≥${montoEsperado} USDC)`);

  return resultado(true, `${monto.toFixed(2)} USDC confirmados en ERC20 (${confirmaciones} bloques)`);
};

/** Enrutador principal: delega a la función correcta según moneda. */
const verificarCrypto = (moneda, txid, montoEsperado) => {
  const { wallet } = CRYPTO_CONFIG[moneda];
  switch (moneda) {
    case 'BTC':  return verificarBTC (txid, wallet, montoEsperado);
    case 'ETH':  return verificarETH (txid, wallet, montoEsperado);
    case 'SOL':  return verificarSOL (txid, wallet, montoEsperado);
    case 'USDT': return verificarUSDT(txid, wallet, montoEsperado);
    case 'USDC': return verificarUSDC(txid, wallet, montoEsperado);
    default: throw new Error(`Moneda no soportada: ${moneda}`);
  }
};

// ─── Notificaciones al admin ──────────────────────────────────────────────────

/** Envía texto + botones al admin cuando llega un TXID o comprobante de texto. */
const notificarAdmin = (ctx, session, datos, verif) => {
  const metodo   = session.estado === 'ESPERANDO_TXID' ? session.moneda : 'SPEI';
  const producto = PRODUCTOS[session.producto];

  const estadoVerif = verif === null
    ? '⚠️ Sin verificación automática — revisar manualmente'
    : verif.ok
      ? `✅ ${verif.detalle}`
      : `❌ ${verif.detalle}`;

  return bot.telegram.sendMessage(
    ADMIN_ID,
    `🚨 *NUEVA VENTA*\n` +
    `👤 Usuario: ${ctx.from.first_name} (ID: \`${ctx.from.id}\`)\n` +
    `🛍 Producto: ${getNombre(session)}\n` +
    `💰 Monto: $${getPrecio(session)} USD\n` +
    `💳 Método: ${metodo}\n` +
    `📋 Datos: \`${datos}\`\n` +
    `🔍 ${estadoVerif}`,
    { parse_mode: 'Markdown', ...botonesAdmin(ctx.from.id) }
  );
};

// ─── Handlers de usuario ──────────────────────────────────────────────────────

// /start — también acepta deep links: t.me/tubot?start=vip
bot.start((ctx) => {
  const payload = ctx.startPayload;
  if (payload && PRODUCTOS[payload]) return seleccionarProducto(ctx, payload);
  ctx.reply('👋 Bienvenido, elige lo que deseas:', teclado.productos);
});

// Selección de producto (botón o deep link)
bot.action(/^prod_(.+)$/, (ctx) => seleccionarProducto(ctx, ctx.match[1]));

// Selección de minutos de sexting
bot.action(/^sexting_min_(\d+)$/, async (ctx) => {
  const minutos   = parseInt(ctx.match[1]);
  const precioUsd = calcularPrecioSexting(minutos);
  const session   = getSession(ctx.from.id);

  // Guardar como si fuera un producto normal para que el resto del flujo funcione igual
  session.producto      = 'sexting';
  session.sextingMin    = minutos;
  session.sextingPrecio = precioUsd; // precio calculado, se usa en lugar de producto.precio
  session.estado        = null;      // limpiar estado anterior

  let lineaPrecio = `💵 Precio: *$${precioUsd} USD*`;
  try {
    const tasa      = await obtenerTipoCambioMXN();
    const precioMxn = (precioUsd * tasa).toFixed(2);
    lineaPrecio     = `💵 Precio: *$${precioUsd} USD* (~$${precioMxn} MXN)`;
    session.tasaMxn = tasa;
  } catch (err) {
    console.error('ExchangeRate error:', err.message);
  }

  ctx.reply(
    `🔥 *Sexting ${minutos} minutos*\n` +
    `${lineaPrecio}\n\n` +
    `Selecciona método de pago:`,
    { parse_mode: 'Markdown', ...teclado.metodoPago }
  );
});

// Selección de moneda cripto
bot.action('pay_crypto_select', (ctx) =>
  ctx.reply('Selecciona moneda:', teclado.monedas)
);

// Datos SPEI
bot.action('pay_spei_data', (ctx) => {
  const clabe   = process.env.CLABE_SPEI ?? 'NO_CONFIGURADA';
  const session = getSession(ctx.from.id);
  session.estado = 'ESPERANDO_COMPROBANTE';

  const precioUsd  = getPrecio(session);
  const lineaMonto = session.tasaMxn
    ? `💰 Monto: *$${(precioUsd * session.tasaMxn).toFixed(2)} MXN* (~$${precioUsd} USD)`
    : `💰 Monto: *$${precioUsd} USD*`;

  ctx.reply(
    `Transfiere a esta CLABE:\n\n` +
    `\`${clabe}\`\n\n` +
    `Titular: TU NOMBRE\n` +
    `${lineaMonto}\n\n` +
    `📎 *Envía aquí una foto o captura de tu comprobante de pago.*\n` +
    `⚠️ Sin comprobante no podemos confirmar tu transferencia.`,
    { parse_mode: 'Markdown' }
  );
});

// Datos de wallet cripto + conversión en tiempo real
bot.action(/^coin_(.+)$/, async (ctx) => {
  const moneda = ctx.match[1];
  const crypto = CRYPTO_CONFIG[moneda];
  if (!crypto) return ctx.reply('Moneda no reconocida. Intenta de nuevo.');

  const session   = getSession(ctx.from.id);
  session.estado  = 'ESPERANDO_TXID';
  session.moneda  = moneda;

  const precioUsd = getPrecio(session);
  await ctx.reply('⏳ Consultando precio en tiempo real...');

  let lineaMonto = `💰 Monto: *$${precioUsd} USD* en ${moneda}`;
  try {
    const cantidad      = await convertirACrypto(moneda, precioUsd);
    session.montoCrypto = parseFloat(cantidad);
    lineaMonto          = `💰 Monto: *${cantidad} ${moneda}* (~$${precioUsd} USD)`;
  } catch (err) {
    console.error('CoinGecko error:', err.message);
  }

  ctx.reply(
    `Envía *${moneda}* a esta dirección:\n\n` +
    `\`${crypto.wallet}\`\n\n` +
    `🌐 Red: ${crypto.red}\n` +
    `${lineaMonto}\n\n` +
    `Una vez enviado, responde con el *TXID / Hash* de tu transacción.\n\n` +
    `📋 Lo encuentras en tu wallet o exchange después de enviar:\n` +
    `\`a1b2c3d4e5f6...\` (cadena larga de letras y números)`,
    { parse_mode: 'Markdown' }
  );
});

// Captura de TXID (crypto) o comprobante en texto (SPEI)
bot.on('text', async (ctx) => {
  const session = userSessions.get(ctx.from.id);
  if (!session?.estado) return;

  const datos    = ctx.message.text;
  const producto = PRODUCTOS[session.producto];
  const esCrypto = session.estado === 'ESPERANDO_TXID';

  await ctx.reply('⏳ Verificando tu pago...');

  let verif = null;
  try {
    if (esCrypto) {
      verif = await verificarCrypto(session.moneda, datos, session.montoCrypto);
    } else {
      const precio  = getPrecio(session);
      const speiOk = await verificarSPEI(precio);
      if (speiOk !== null)
        verif = speiOk
          ? { ok: true,  detalle: `Pago SPEI de $${precio} USD verificado en Conekta` }
          : { ok: false, detalle: `No se encontró pago SPEI de $${precio} USD en Conekta` };
    }
  } catch (err) {
    console.error('Error verificación:', err.message);
  }

  try {
    await notificarAdmin(ctx, session, datos, verif);
  } catch (err) {
    console.error('Error notificando admin:', err.message);
  }

  // Respuesta al usuario — crypto da resultado exacto, SPEI siempre es manual
  if (esCrypto) {
    if (verif?.ok === true) {
      await ctx.reply(
        `✅ *¡Pago verificado en blockchain!*\n\n` +
        `${verif.detalle}\n\n` +
        `El admin procesará tu acceso en breve.`,
        { parse_mode: 'Markdown' }
      );
    } else if (verif?.ok === false) {
      await ctx.reply(
        `❌ *No pudimos confirmar tu pago.*\n\n` +
        `Motivo: ${verif.detalle}\n\n` +
        `Verifica que el TXID sea correcto y que la transacción ya esté confirmada.\n` +
        `Si crees que es un error, el equipo lo revisará manualmente.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(
        `⚠️ *No pudimos conectar con la blockchain ahora mismo.*\n\n` +
        `Tu TXID fue registrado y el equipo lo verificará manualmente. Te avisamos pronto.`,
        { parse_mode: 'Markdown' }
      );
    }
  } else {
    await ctx.reply(
      `📨 *Comprobante recibido.*\n\n` +
      `Los pagos SPEI se verifican manualmente. Te confirmamos el acceso en breve.`,
      { parse_mode: 'Markdown' }
    );
  }

  userSessions.delete(ctx.from.id);
});

// Captura de foto como comprobante SPEI
bot.on('photo', async (ctx) => {
  const session = userSessions.get(ctx.from.id);
  if (session?.estado !== 'ESPERANDO_COMPROBANTE') return;

  const producto = PRODUCTOS[session.producto];
  const fileId   = ctx.message.photo.at(-1).file_id; // máxima resolución

  try {
    await bot.telegram.sendPhoto(ADMIN_ID, fileId, {
      caption:
        `🚨 *COMPROBANTE SPEI*\n` +
        `👤 Usuario: ${ctx.from.first_name} (ID: \`${ctx.from.id}\`)\n` +
        `🛍 Producto: ${getNombre(session)}\n` +
        `💰 Monto: $${getPrecio(session)} USD`,
      parse_mode: 'Markdown',
      ...botonesAdmin(ctx.from.id),
    });

    await ctx.reply(
      `📨 *Comprobante recibido.*\n\n` +
      `Los pagos SPEI se verifican manualmente. Te confirmamos el acceso en breve.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Error reenviando foto al admin:', err.message);
    await ctx.reply('⚠️ Hubo un problema al enviar tu comprobante. Intenta de nuevo.');
  }

  userSessions.delete(ctx.from.id);
});

// ─── Handlers admin (aprobar / rechazar) ─────────────────────────────────────

bot.action(/^admin_aprobar_(\d+)$/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.answerCbQuery('⛔ Sin permisos');
  const userId = parseInt(ctx.match[1]);
  try {
    await bot.telegram.sendMessage(
      userId,
      '🎉 *¡Pago aprobado!*\nGracias por tu compra. Tu acceso está siendo procesado y lo recibirás en breve.',
      { parse_mode: 'Markdown' }
    );
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.answerCbQuery('✅ Usuario notificado');
  } catch (err) {
    console.error('Error aprobando:', err.message);
    await ctx.answerCbQuery('❌ Error al notificar al usuario');
  }
});

bot.action(/^admin_rechazar_(\d+)$/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.answerCbQuery('⛔ Sin permisos');
  const userId = parseInt(ctx.match[1]);
  try {
    await bot.telegram.sendMessage(
      userId,
      '❌ *Pago no confirmado.*\nNo pudimos verificar tu pago. Si crees que es un error, contáctanos directamente.',
      { parse_mode: 'Markdown' }
    );
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.answerCbQuery('❌ Usuario notificado del rechazo');
  } catch (err) {
    console.error('Error rechazando:', err.message);
    await ctx.answerCbQuery('❌ Error al notificar al usuario');
  }
});

// ─── Launch ───────────────────────────────────────────────────────────────────

bot.launch();
console.log('🤖 Bot iniciado.');

// Servidor HTTP para health checks de Render (evita que el servicio duerma)
const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => console.log(`🌐 Health check escuchando en puerto ${PORT}`));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));