require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

// ─── Config ───────────────────────────────────────────────────────────────────

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;
const userSessions = new Map();

const PRODUCTOS = {
  vip:       { nombre: 'Acceso Grupo VIP',     precio: 10 },
  pack1:     { nombre: '10 Fotos + 5 Videos', precio: 15 },
  pack2:     { nombre: '20 Fotos + 10 Videos', precio: 25 },
  sexting30: { nombre: 'Sexting 30 Minutos',   precio: 40 },
  sexting60: { nombre: 'Sexting 1 Hora',       precio: 70 },
};

const CRYPTO_CONFIG = {
  BTC:  { nombre: 'Bitcoin',  red: 'Bitcoin',      wallet: process.env.WALLET_BTC,  geckoId: 'bitcoin',   decimales: 8 },
  ETH:  { nombre: 'Ethereum', red: 'ERC20',        wallet: process.env.WALLET_ETH,  geckoId: 'ethereum',  decimales: 8 },
  SOL:  { nombre: 'Solana',   red: 'Solana',       wallet: process.env.WALLET_SOL,  geckoId: 'solana',    decimales: 4 },
  USDT: { nombre: 'Tether',   red: 'TRC20',        wallet: process.env.WALLET_USDT, geckoId: 'tether',    decimales: 2 },
  USDC: { nombre: 'USD Coin', red: 'SPL/Polygon',  wallet: process.env.WALLET_USDC, geckoId: 'usd-coin',  decimales: 2 },
};

// ─── Teclados (Movido aquí para que sea accesible) ───────────────────────────

const teclado = {
  productos: Markup.inlineKeyboard([
    [Markup.button.callback('💎 Grupo VIP',        'prod_vip')],
    [Markup.button.callback('📸 Pack 10F+5V',     'prod_pack1')],
    [Markup.button.callback('📸 Pack 20F+10V',    'prod_pack2')],
    [Markup.button.callback('🔥 Sexting 30min',   'prod_sexting30')],
    [Markup.button.callback('🔥 Sexting 60min',   'prod_sexting60')],
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

const getSession = (userId) => {
  if (!userSessions.has(userId)) userSessions.set(userId, {});
  return userSessions.get(userId);
};

const convertirACrypto = async (moneda, usd) => {
  const { geckoId, decimales } = CRYPTO_CONFIG[moneda];
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd`);
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json();
  const precioUsd = data[geckoId]?.usd;
  if (!precioUsd) throw new Error('Precio no disponible');
  return (usd / precioUsd).toFixed(decimales);
};

const obtenerTipoCambioMXN = async () => {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  if (!res.ok) throw new Error(`ExchangeRate HTTP ${res.status}`);
  const data = await res.json();
  const tasa = data.rates?.MXN;
  if (!tasa) throw new Error('Tasa MXN no disponible');
  return tasa;
};

// ─── Verificación SPEI (Conekta) ─────────────────────────────────────────────

const verificarSPEI = async (montoUsd) => {
  const apiKey = process.env.CONEKTA_API_KEY;
  if (!apiKey) return null; 

  const res = await fetch('https://api.conekta.io/orders?limit=20', {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.conekta-v2.2.0+json',
    },
  });
  if (!res.ok) throw new Error(`Conekta HTTP ${res.status}`);

  const data = await res.json();
  const hace1hora = Math.floor(Date.now() / 1000) - 3600;
  const montoCentavos = montoUsd * 100;

  return data.data?.some(order =>
    order.payment_status === 'paid' &&
    order.amount === montoCentavos &&
    order.created_at >= hace1hora &&
    order.charges?.data?.some(c => c.payment_method?.type === 'spei')
  ) ?? false;
};

// ─── Verificación Crypto ────────────────────────────────────────────────────

const CONFIRMACIONES_MIN = { BTC: 2, ETH: 12, SOL: 1, USDT: 20, USDC: 12 };
const TOLERANCIA = 0.98;

const resultado = (ok, detalle) => ({ ok, detalle });

const verificarBTC = async (txid, wallet, montoEsperado) => {
  const res = await fetch(`https://blockstream.info/api/tx/${txid}`);
  if (!res.ok) throw new Error(`Blockstream HTTP ${res.status}`);
  const tx = await res.json();
  const confirmaciones = tx.status?.block_height ? await fetch('https://blockstream.info/api/blocks/tip/height').then(r => r.json()).then(tip => tip - tx.status.block_height + 1) : 0;
  if (confirmaciones < CONFIRMACIONES_MIN.BTC) return resultado(false, `Solo ${confirmaciones}/${CONFIRMACIONES_MIN.BTC} confirmaciones`);
  const satoshisEsperados = Math.round(montoEsperado * 1e8);
  const output = tx.vout?.find(o => o.scriptpubkey_address === wallet);
  if (!output) return resultado(false, `Destino no coincide`);
  if (output.value < satoshisEsperados * TOLERANCIA) return resultado(false, `Monto insuficiente`);
  return resultado(true, `${output.value / 1e8} BTC confirmados`);
};

const verificarETH = async (txid, wallet, montoEsperado) => {
  const apiKey = process.env.ETHERSCAN_API_KEY ?? '';
  const [resRecibo, resTx] = await Promise.all([
    fetch(`https://api.etherscan.io/api?module=transaction&action=gettxreceiptstatus&txhash=${txid}&apikey=${apiKey}`),
    fetch(`https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=${txid}&apikey=${apiKey}`),
  ]);
  const recibo = await resRecibo.json();
  const txData = await resTx.json();
  const tx = txData.result;
  if (recibo.result?.status !== '1' || tx?.to?.toLowerCase() !== wallet.toLowerCase()) return resultado(false, `Transacción inválida o mal destino`);
  const resBloque = await fetch(`https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${apiKey}`);
  const bloqueData = await resBloque.json();
  const confirmaciones = parseInt(bloqueData.result, 16) - parseInt(tx.blockNumber, 16);
  if (confirmaciones < CONFIRMACIONES_MIN.ETH) return resultado(false, `Solo ${confirmaciones} confirmaciones`);
  const valorEth = parseInt(tx.value, 16) / 1e18;
  if (valorEth < montoEsperado * TOLERANCIA) return resultado(false, `Monto insuficiente`);
  return resultado(true, `${valorEth.toFixed(6)} ETH confirmados`);
};

const verificarSOL = async (txid, wallet, montoEsperado) => {
  const res = await fetch(`https://public-api.solscan.io/transaction/${txid}`);
  if (!res.ok) throw new Error(`Solscan HTTP ${res.status}`);
  const tx = await res.json();
  if (tx.status !== 'Success') return resultado(false, `Estado: ${tx.status}`);
  const transferencia = tx.innerInstructions?.flatMap(i => i.instructions ?? []).find(i => i.parsed?.info?.destination === wallet) ?? tx.tokenTransfers?.find(t => t.destinationOwner === wallet);
  if (!transferencia) return resultado(false, `Destino no coincide`);
  const lamports = transferencia.parsed?.info?.lamports ?? (transferencia.amount * 1e9);
  const solRecibido = lamports / 1e9;
  if (solRecibido < montoEsperado * TOLERANCIA) return resultado(false, `Monto insuficiente`);
  return resultado(true, `${solRecibido.toFixed(4)} SOL confirmados`);
};

const verificarUSDT = async (txid, wallet, montoEsperado) => {
  const res = await fetch(`https://apilist.tronscanapi.com/api/transaction-info?hash=${txid}`);
  const tx = await res.json();
  if (tx.contractRet !== 'SUCCESS' || tx.toAddress?.toLowerCase() !== wallet.toLowerCase()) return resultado(false, `Transacción inválida`);
  if ((tx.confirmations ?? 0) < CONFIRMACIONES_MIN.USDT) return resultado(false, `Solo ${tx.confirmations} confirmaciones`);
  const monto = (tx.trigger_info?.parameter?._value ?? tx.amount ?? 0) / 1e6;
  if (monto < montoEsperado * TOLERANCIA) return resultado(false, `Monto insuficiente`);
  return resultado(true, `${monto.toFixed(2)} USDT confirmados`);
};

const verificarUSDC = async (txid, wallet, montoEsperado) => {
  const apiKey = process.env.ETHERSCAN_API_KEY ?? '';
  const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const res = await fetch(`https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=${USDC_CONTRACT}&address=${wallet}&txhash=${txid}&apikey=${apiKey}`);
  const data = await res.json();
  const transfer = data.result?.find(t => t.hash.toLowerCase() === txid.toLowerCase() && t.to.toLowerCase() === wallet.toLowerCase());
  if (!transfer || parseInt(transfer.confirmations ?? 0) < CONFIRMACIONES_MIN.USDC) return resultado(false, `Transferencia no encontrada o pocas confirmaciones`);
  const monto = parseInt(transfer.value) / 1e6;
  if (monto < montoEsperado * TOLERANCIA) return resultado(false, `Monto insuficiente`);
  return resultado(true, `${monto.toFixed(2)} USDC confirmados`);
};

const verificarCrypto = async (moneda, txid, montoEsperado) => {
  const { wallet } = CRYPTO_CONFIG[moneda];
  switch (moneda) {
    case 'BTC':  return verificarBTC(txid, wallet, montoEsperado);
    case 'ETH':  return verificarETH(txid, wallet, montoEsperado);
    case 'SOL':  return verificarSOL(txid, wallet, montoEsperado);
    case 'USDT': return verificarUSDT(txid, wallet, montoEsperado);
    case 'USDC': return verificarUSDC(txid, wallet, montoEsperado);
    default: throw new Error(`Moneda no soportada`);
  }
};

// ─── Lógica central de selección ──────────────────────────────────────────────

const handleProductSelection = async (ctx, prodId) => {
  const session = getSession(ctx.from.id);
  session.producto = prodId;

  const producto = PRODUCTOS[prodId];
  const precioUsd = producto?.precio ?? 0;

  let lineaPrecio = `💵 Precio: *$${precioUsd} USD*`;
  try {
    const tasa = await obtenerTipoCambioMXN();
    const precioMxn = (precioUsd * tasa).toFixed(2);
    lineaPrecio = `💵 Precio: *$${precioUsd} USD* (~$${precioMxn} MXN)`;
    session.tasaMxn = tasa;
  } catch (err) { console.error(err); }

  ctx.reply(
    `🛍 *${producto?.nombre}*\n${lineaPrecio}\n\nSelecciona método de pago:`,
    { parse_mode: 'Markdown', ...teclado.metodoPago }
  );
};

// ─── Handlers ─────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  if (payload && PRODUCTOS[payload]) return handleProductSelection(ctx, payload);
  ctx.reply('👋 Bienvenido, elige lo que deseas:', teclado.productos);
});

bot.action(/^prod_(.+)$/, (ctx) => handleProductSelection(ctx, ctx.match[1]));

bot.action('pay_crypto_select', (ctx) => ctx.reply('Selecciona moneda:', teclado.monedas));

bot.action('pay_spei_data', (ctx) => {
  const clabe = process.env.CLABE_SPEI ?? 'NO_CONFIGURADA';
  const session = getSession(ctx.from.id);
  session.estado = 'ESPERANDO_COMPROBANTE';
  const precioUsd = PRODUCTOS[session.producto]?.precio ?? 0;
  let lineaMonto = session.tasaMxn ? `💰 Monto: *$${(precioUsd * session.tasaMxn).toFixed(2)} MXN*` : `💰 Monto: *$${precioUsd} USD*`;
  ctx.reply(`Transfiere a esta CLABE:\n\n\`${clabe}\`\n\nTitular: TU NOMBRE\n${lineaMonto}\n\n📎 *Envía captura de tu comprobante.*`, { parse_mode: 'Markdown' });
});

bot.action(/^coin_(.+)$/, async (ctx) => {
  const moneda = ctx.match[1];
  const crypto = CRYPTO_CONFIG[moneda];
  const session = getSession(ctx.from.id);
  session.estado = 'ESPERANDO_TXID';
  session.moneda = moneda;
  await ctx.reply('⏳ Consultando precio...');
  try {
    const cantidad = await convertirACrypto(moneda, PRODUCTOS[session.producto].precio);
    session.montoCrypto = parseFloat(cantidad);
    ctx.reply(`Envía *${moneda}* a:\n\n\`${crypto.wallet}\`\n\n🌐 Red: ${crypto.red}\n💰 Monto: *${cantidad} ${moneda}*\n\nResponde con el TXID/Hash.`, { parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply(`Envía ${moneda} a:\n\`${crypto.wallet}\`\n\nResponde con el TXID/Hash.`, { parse_mode: 'Markdown' });
  }
});

bot.on('text', async (ctx) => {
  const session = userSessions.get(ctx.from.id);
  if (!session?.estado) return;
  const datos = ctx.message.text;
  session.userId = ctx.from.id;
  session.userName = ctx.from.first_name;
  session.datos = datos;
  
  let verif = null;
  try {
    verif = session.estado === 'ESPERANDO_TXID' 
      ? await verificarCrypto(session.moneda, datos, session.montoCrypto)
      : await verificarSPEI(PRODUCTOS[session.producto]?.precio ?? 0);
  } catch (e) { console.error(e); }

  // Notificación al Admin
  bot.telegram.sendMessage(ADMIN_ID, `🚨 *NUEVA VENTA*\nUser: ${ctx.from.first_name}\nProd: ${PRODUCTOS[session.producto].nombre}\nInfo: \`${datos}\`\nResult: ${verif?.detalle ?? 'Manual'}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('✅ Aprobar', `admin_aprobar_${ctx.from.id}`), Markup.button.callback('❌ Rechazar', `admin_rechazar_${ctx.from.id}`)]])
  });

  ctx.reply('Pago recibido. Estoy verificando...');
  userSessions.delete(ctx.from.id);
});

// Admin Handlers
bot.action(/^admin_aprobar_(\d+)$/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.answerCbQuery('❌');
  await bot.telegram.sendMessage(ctx.match[1], '🎉 *¡Pago aprobado!*\nTu acceso está siendo procesado.', { parse_mode: 'Markdown' });
  await ctx.editMessageReplyMarkup(undefined);
  ctx.answerCbQuery('✅');
});

bot.action(/^admin_rechazar_(\d+)$/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.answerCbQuery('❌');
  await bot.telegram.sendMessage(ctx.match[1], '❌ *Pago no confirmado.* Contáctanos.', { parse_mode: 'Markdown' });
  await ctx.editMessageReplyMarkup(undefined);
  ctx.answerCbQuery('❌');
});

bot.launch();
console.log('🤖 Bot iniciado.');