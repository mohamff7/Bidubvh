// متجر اشتراكات تيليجرام — ملف واحد لـ Cloudflare Workers (يضم السيرفر والواجهة).
import { DurableObject } from 'cloudflare:workers';

/* ───────── بيانات المنتجات الأولية ───────── */
// بيانات تجريبية: عدّل الأسماء والأسعار (بالسنت) كما تريد، أو احذف data/store.db ليُعاد التحميل.
// manual: 1 = التسليم يدوي من المشرف عند نفاد المخزون، 0 = لا تُباع إلا إذا توفّر مخزون.

const CATEGORIES = [
  { key: 'video', name: 'مشاهدة' },
  { key: 'music', name: 'موسيقى' },
  { key: 'ai', name: 'ذكاء اصطناعي' },
  { key: 'games', name: 'ألعاب' },
  { key: 'apps', name: 'تصميم وتواصل' },
];

const PRODUCTS = [
  {
    name: 'Netflix', cat: 'video', color: '#F0525C', glyph: 'N',
    desc: 'أفلام ومسلسلات وأعمال أصلية',
    plans: [
      { label: 'شهر واحد', price: 600, manual: 1 },
      { label: '3 أشهر', price: 1700, manual: 1 },
    ],
  },
  {
    name: 'Shahid', cat: 'video', color: '#F5C542', glyph: 'ش',
    desc: 'مسلسلات وأفلام عربية وعالمية',
    plans: [
      { label: 'شهر واحد', price: 600, manual: 1 },
      { label: '3 أشهر', price: 1600, manual: 1 },
    ],
  },
  {
    name: 'Disney+', cat: 'video', color: '#3E7BFA', glyph: 'D+',
    desc: 'أفلام عائلية وسلاسل شهيرة',
    plans: [
      { label: 'شهر واحد', price: 500, manual: 1 },
      { label: 'سنة كاملة', price: 4500, manual: 1 },
    ],
  },
  {
    name: 'YouTube Premium', cat: 'video', color: '#FF8A3D', glyph: 'Y',
    desc: 'يوتيوب بدون إعلانات مع تشغيل في الخلفية',
    plans: [
      { label: 'شهر واحد', price: 400, manual: 1 },
      { label: '3 أشهر', price: 1100, manual: 1 },
    ],
  },
  {
    name: 'Spotify Premium', cat: 'music', color: '#35D07F', glyph: 'S',
    desc: 'موسيقى بدون إعلانات وتحميل للاستماع دون إنترنت',
    plans: [
      { label: 'شهر واحد', price: 500, manual: 1 },
      { label: '3 أشهر', price: 1300, manual: 1 },
      { label: 'سنة كاملة', price: 4800, manual: 1 },
    ],
  },
  {
    name: 'ChatGPT Plus', cat: 'ai', color: '#7C6CFF', glyph: 'G',
    desc: 'مساعد ذكاء اصطناعي بميزات متقدمة',
    plans: [{ label: 'شهر واحد', price: 2000, manual: 1 }],
  },
  {
    name: 'PlayStation Plus', cat: 'games', color: '#E6E9F5', glyph: 'P+',
    desc: 'ألعاب شهرية ولعب أونلاين',
    plans: [
      { label: 'شهر واحد', price: 900, manual: 1 },
      { label: '3 أشهر', price: 2500, manual: 1 },
    ],
  },
  {
    name: 'Canva Pro', cat: 'apps', color: '#22C7E8', glyph: 'Ca',
    desc: 'تصميم بقوالب وأدوات متقدمة',
    plans: [
      { label: 'شهر واحد', price: 300, manual: 1 },
      { label: 'سنة كاملة', price: 2500, manual: 1 },
    ],
  },
  {
    name: 'Discord Nitro', cat: 'apps', color: '#FF7AB6', glyph: 'Dc',
    desc: 'ميزات متقدمة للخوادم والملف الشخصي',
    plans: [{ label: 'شهر واحد', price: 800, manual: 1 }],
  },
];

/* ───────── منطق المتجر (Durable Object) ───────── */

const TOPUPS = [5, 10, 25, 50]; // باقات الشحن بالدولار
const enc = new TextEncoder();
const WEB_BASE = 1_000_000_000_000; // معرّفات حسابات الموقع تبدأ من هنا حتى لا تتعارض مع معرّفات تيليجرام
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const safeEqual = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
async function pbkdf2(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const now = () => Math.floor(Date.now() / 1000);
const usd = (c) => `$${(c / 100).toFixed(2)}`;
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/* ───────── التحقق من هوية تيليجرام (WebCrypto) ───────── */
async function hmacSign(keyBytes, dataBytes) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, dataBytes));
}

async function verifyInitData(raw, token) {
  const p = new URLSearchParams(raw);
  const hash = p.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  p.delete('hash');
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmacSign(enc.encode('WebAppData'), enc.encode(token));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sig = Uint8Array.from(hash.match(/../g).map((h) => parseInt(h, 16)));
  if (!(await crypto.subtle.verify('HMAC', key, sig, enc.encode(check)))) return null; // مقارنة ثابتة الزمن
  if (now() - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.token = env.BOT_TOKEN || '';
    this.dev = env.DEV === '1';
    this.rate = Number(env.STARS_PER_USD || 50);
    this.admins = String(env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
    this.support = String(env.SUPPORT_USERNAME || '').replace('@', '');
    this.sifaloUser = env.SIFALO_API_USER || '';
    this.sifaloKey = env.SIFALO_API_KEY || '';
    this.sifalo = !!(this.sifaloUser && this.sifaloKey);
    this.staging = env.SIFALO_ENV === 'staging';
    this.adminPassword = env.ADMIN_PASSWORD || '';
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  /* ───────── قاعدة البيانات ───────── */
  all(sql, ...p) { return this.sql.exec(sql, ...p).toArray(); }
  get(sql, ...p) { return this.all(sql, ...p)[0] ?? null; }
  run(sql, ...p) { return this.all(sql, ...p); } // استخدم RETURNING لمعرفة هل تغيّر شيء
  tx(fn) { return this.ctx.storage.transactionSync(fn); }

  migrate() {
    const stmts = [
      'CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, username TEXT, balance INTEGER NOT NULL DEFAULT 0, created INTEGER)',
      'CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT, cat TEXT, color TEXT, glyph TEXT, descr TEXT, sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1)',
      'CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY, product_id INTEGER, label TEXT, price INTEGER, manual INTEGER DEFAULT 1, active INTEGER DEFAULT 1)',
      'CREATE TABLE IF NOT EXISTS stock(id INTEGER PRIMARY KEY, plan_id INTEGER, content TEXT, order_id INTEGER)',
      'CREATE INDEX IF NOT EXISTS stock_free ON stock(plan_id, order_id)',
      'CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, user_id INTEGER, plan_id INTEGER, price INTEGER, stars INTEGER, method TEXT, status TEXT, delivery TEXT, created INTEGER, updated INTEGER)',
      'CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, user_id INTEGER, delta INTEGER, note TEXT, created INTEGER)',
      'CREATE TABLE IF NOT EXISTS web_accounts(email TEXT PRIMARY KEY, user_id INTEGER UNIQUE, salt TEXT, hash TEXT, created INTEGER)',
      'CREATE TABLE IF NOT EXISTS web_sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER, expires INTEGER)',
      'CREATE TABLE IF NOT EXISTS login_fail(email TEXT PRIMARY KEY, n INTEGER, until INTEGER)',
      'CREATE TABLE IF NOT EXISTS topups(ref TEXT PRIMARY KEY, user_id INTEGER, cents INTEGER, gw_key TEXT, sid TEXT, status TEXT, checked INTEGER DEFAULT 0, created INTEGER)',
      'CREATE UNIQUE INDEX IF NOT EXISTS topups_sid ON topups(sid) WHERE sid IS NOT NULL',
      'CREATE TABLE IF NOT EXISTS payments(charge_id TEXT PRIMARY KEY, user_id INTEGER, payload TEXT, stars INTEGER, created INTEGER)',
    ];
    for (const s of stmts) this.run(s);
    if (!this.get('SELECT COUNT(*) AS n FROM products').n) {
      PRODUCTS.forEach((p, i) => {
        const r = this.get('INSERT INTO products(name,cat,color,glyph,descr,sort) VALUES (?,?,?,?,?,?) RETURNING id', p.name, p.cat, p.color, p.glyph, p.desc, i);
        for (const pl of p.plans) this.run('INSERT INTO plans(product_id,label,price,manual) VALUES (?,?,?,?)', r.id, pl.label, pl.price, pl.manual);
      });
    }
  }

  starsFor(cents) { return Math.ceil((cents * this.rate) / 100); }
  centsFor(stars) { return Math.floor((stars * 100) / this.rate); }

  /* ───────── تيليجرام ───────── */
  async tg(method, body = {}) {
    if (!this.token) throw new Error('BOT_TOKEN غير مضبوط');
    const r = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`${method}: ${j.description}`);
    return j.result;
  }
  say(chat_id, text, extra = {}) {
    if (!this.token || chat_id >= WEB_BASE) return null;
    return this.tg('sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra }).catch((e) => console.error(e.message));
  }
  tellAdmins(text) { return Promise.all(this.admins.map((id) => this.say(id, text))); }

  /* ───────── المستخدمون والرصيد ───────── */
  upsertUser(u) {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'مستخدم';
    this.run(`INSERT INTO users(id,name,username,created) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username`, u.id, name, u.username ?? null, now());
    return this.get('SELECT * FROM users WHERE id=?', u.id);
  }
  addBalance(userId, delta, note) {
    this.run('UPDATE users SET balance=balance+? WHERE id=?', delta, userId);
    this.run('INSERT INTO ledger(user_id,delta,note,created) VALUES (?,?,?,?)', userId, delta, note, now());
  }

  async auth(request) {
    const raw = request.headers.get('x-init-data');
    if (raw) {
      const u = await verifyInitData(raw, this.token);
      if (u) return this.upsertUser(u);
      throw httpErr(401, 'انتهت الجلسة. أغلق المتجر وافتحه من جديد');
    }
    const bearer = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') || '');
    if (bearer) {
      const row = this.get('SELECT user_id FROM web_sessions WHERE token_hash=? AND expires>?', await sha256hex(bearer[1]), now());
      if (row && row.user_id > 0) return this.get('SELECT * FROM users WHERE id=?', row.user_id);
    }
    if (this.dev && !bearer) return this.upsertUser({ id: 1, first_name: 'مستخدم', last_name: 'تجريبي', username: 'dev' });
    throw httpErr(401, 'سجّل الدخول للمتابعة');
  }

  /* ───────── حسابات الموقع ───────── */
  async newSession(userId, ttl = 30 * 86400) {
    const token = randHex(32);
    this.run('DELETE FROM web_sessions WHERE expires<?', now());
    this.run('INSERT INTO web_sessions(token_hash,user_id,expires) VALUES (?,?,?)', await sha256hex(token), userId, now() + ttl);
    return token;
  }

  async signup({ email, password, name }) {
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');
    name = String(name || '').trim().slice(0, 40) || email.split('@')[0];
    if (!EMAIL_RE.test(email) || email.length > 120) throw httpErr(400, 'اكتب بريدًا إلكترونيًا صحيحًا');
    if (password.length < 8 || password.length > 100) throw httpErr(400, 'كلمة المرور من 8 إلى 100 حرف');
    if (this.get('SELECT 1 AS x FROM web_accounts WHERE email=?', email)) throw httpErr(409, 'هذا البريد مسجّل من قبل. سجّل الدخول');
    const salt = randHex(16);
    const hash = await pbkdf2(password, salt);
    const userId = this.tx(() => {
      const id = this.get('SELECT COALESCE(MAX(id), ?) + 1 AS n FROM users WHERE id>=?', WEB_BASE, WEB_BASE).n;
      this.run('INSERT INTO users(id,name,username,created) VALUES (?,?,?,?)', id, name, null, now());
      this.run('INSERT INTO web_accounts(email,user_id,salt,hash,created) VALUES (?,?,?,?,?)', email, id, salt, hash, now());
      return id;
    });
    return { token: await this.newSession(userId) };
  }

  async login({ email, password }) {
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');
    const f = this.get('SELECT * FROM login_fail WHERE email=?', email);
    if (f && f.until > now()) throw httpErr(429, 'محاولات كثيرة. حاول بعد 15 دقيقة');
    const acc = this.get('SELECT * FROM web_accounts WHERE email=?', email);
    // نحسب الاشتقاق حتى لو الحساب غير موجود، لتتساوى أزمنة الاستجابة
    const calc = await pbkdf2(password.slice(0, 100), acc ? acc.salt : '00'.repeat(16));
    if (!acc || !safeEqual(calc, acc.hash)) {
      const n = (f?.n || 0) + 1;
      this.run('INSERT INTO login_fail(email,n,until) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET n=excluded.n, until=excluded.until',
        email.slice(0, 120), n >= 5 ? 0 : n, n >= 5 ? now() + 900 : 0);
      throw httpErr(401, 'البريد أو كلمة المرور غير صحيحة');
    }
    this.run('DELETE FROM login_fail WHERE email=?', email);
    return { token: await this.newSession(acc.user_id) };
  }

  logout(request) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') || '');
    return m ? sha256hex(m[1]).then((h) => { this.run('DELETE FROM web_sessions WHERE token_hash=?', h); return { ok: true }; }) : { ok: true };
  }

  /* ───────── الشحن عبر Sifalo Pay (صفحة دفع مستضافة) ───────── */
  sifaloHosts() {
    return this.staging
      ? { api: 'https://spay-api.sifalo.net/gateway/', checkout: 'https://pay.sifalo.net/checkout/' }
      : { api: 'https://api.sifalopay.com/gateway/', checkout: 'https://pay.sifalo.com/checkout/' };
  }
  sifaloAuth() { return 'Basic ' + btoa(`${this.sifaloUser}:${this.sifaloKey}`); }

  async webTopup(user, origin, { usd: amount }) {
    amount = Number(amount);
    if (user.id < WEB_BASE) throw httpErr(400, 'هذا الشحن لحسابات الموقع. من تيليجرام اشحن بالنجوم');
    if (!TOPUPS.includes(amount)) throw httpErr(400, 'باقة الشحن غير صحيحة');
    if (!this.sifalo && !this.dev) throw httpErr(503, 'الشحن غير مفعّل بعد');
    const ref = randHex(12);
    this.run('INSERT INTO topups(ref,user_id,cents,gw_key,status,created) VALUES (?,?,?,?,?,?)', ref, user.id, amount * 100, '', 'pending', now());
    if (!this.sifalo) { // وضع التجربة بدون بوابة دفع
      this.run("UPDATE topups SET gw_key='dev' WHERE ref=?", ref);
      return { url: `${origin}/?topup=${ref}`, ref };
    }
    const h = this.sifaloHosts();
    let r = null;
    let j = null;
    try {
      r = await fetch(h.api, {
        method: 'POST',
        headers: { authorization: this.sifaloAuth(), 'content-type': 'application/json' },
        body: JSON.stringify({ amount: String(amount), gateway: 'checkout', currency: 'USD', return_url: `${origin}/?topup=${ref}&order_id=${ref}` }),
      });
      j = await r.json().catch(() => null);
    } catch (e) { console.error('sifalo create', e.message); j = { error: 'network: ' + e.message }; }
    const key = j?.key ?? j?.data?.key;
    const token = j?.token ?? j?.data?.token;
    if (!r?.ok || !key || !token) {
      console.error('sifalo create failed', r?.status, JSON.stringify(j)?.slice(0, 300));
      this.run("UPDATE topups SET status='failed' WHERE ref=?", ref);
      const why = String(j?.message ?? j?.error ?? j?.response ?? '').replace(/[^\x20-\x7E\u0600-\u06FF]/g, '').slice(0, 120);
      const hint = r?.status === 401 || r?.status === 403 ? ' (تحقق من مفتاح Sifalo وأنه يطابق البيئة live/staging)' : '';
      throw httpErr(502, `تعذّر فتح صفحة الدفع [${r?.status ?? 'لا اتصال'}${why ? ': ' + why : ''}]${hint}`);
    }
    this.run('UPDATE topups SET gw_key=? WHERE ref=?', String(key), ref);
    return { url: `${h.checkout}?key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`, ref };
  }

  // التحقق يتم بمعرّف الطلب (order_id) العشوائي الذي أنشأناه نحن، لا بالـ sid القادم من المتصفح.
  // verify.php عندهم بلا مصادقة ويقبل أي sid، فلو وثقنا بالـ sid لاستطاع أحدهم تقديم دفعة تاجر آخر.
  async sifaloVerify(ref) {
    try {
      const r = await fetch(this.sifaloHosts().api + 'verify.php', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order_id: ref }),
      });
      const j = await r.json().catch(() => null);
      return r.ok ? j : null;
    } catch (e) { console.error('sifalo verify', e.message); return null; }
  }
  isPaid(j, t) {
    return !!j && String(j.status).toLowerCase() === 'success' && Number(j.code) === 601 && !!j.sid
      && Math.abs(Number(j.amount) - t.cents / 100) < 0.005
      && String(j.currency || 'USD').toUpperCase() === 'USD'
      && (!j.order_id || String(j.order_id) === t.ref);
  }

  // يضيف رصيد الشحنة مرة واحدة فقط (الحالة pending → paid داخل معاملة، وsid فريد فلا تُستخدم دفعة مرتين)
  creditTopup(t, sid, note) {
    try {
      return this.tx(() => {
        if (!this.all("UPDATE topups SET status='paid', sid=? WHERE ref=? AND status='pending' RETURNING ref", sid, t.ref).length) return false;
        this.addBalance(t.user_id, t.cents, note);
        return true;
      });
    } catch (e) { console.error('credit topup', t.ref, e.message); return false; }
  }

  async settleTopups(user, ref = null) {
    const rows = ref
      ? this.all("SELECT * FROM topups WHERE ref=? AND user_id=? AND status='pending'", ref, user.id)
      : this.all("SELECT * FROM topups WHERE user_id=? AND status='pending' AND created>? AND checked<? ORDER BY created DESC LIMIT 3", user.id, now() - 86400, now() - 15);
    for (const t of rows) {
      this.run('UPDATE topups SET checked=? WHERE ref=?', now(), t.ref);
      if (t.gw_key === 'dev') { if (this.dev && !this.sifalo && ref) this.creditTopup(t, `dev_${t.ref}`, `شحن عبر Sifalo — $${t.cents / 100}`); continue; }
      if (!t.gw_key || !this.sifalo) continue;
      const j = await this.sifaloVerify(t.ref);
      if (this.isPaid(j, t)) this.creditTopup(t, String(j.sid), `شحن عبر Sifalo — $${t.cents / 100}`);
    }
  }

  /* ───────── الكتالوج والحالة ───────── */
  planRow(id) {
    return this.get(`SELECT pl.*, pr.name AS product,
      (SELECT COUNT(*) FROM stock s WHERE s.plan_id=pl.id AND s.order_id IS NULL) AS stock
      FROM plans pl JOIN products pr ON pr.id=pl.product_id WHERE pl.id=? AND pl.active=1 AND pr.active=1`, id);
  }
  isAvailable(pl) { return pl.manual === 1 || pl.stock > 0; }

  catalog() {
    const plans = this.all(`SELECT pl.*, (SELECT COUNT(*) FROM stock s WHERE s.plan_id=pl.id AND s.order_id IS NULL) AS stock
      FROM plans pl WHERE pl.active=1 ORDER BY pl.price, pl.id`);
    return this.all('SELECT * FROM products WHERE active=1 ORDER BY sort, id').map((p) => ({
      id: p.id, name: p.name, cat: p.cat, color: p.color, glyph: p.glyph, desc: p.descr,
      plans: plans.filter((x) => x.product_id === p.id).map((x) => ({
        id: x.id, label: x.label, price: x.price, stars: this.starsFor(x.price), available: this.isAvailable(x),
      })),
    })).filter((p) => p.plans.length);
  }

  publicConfig() {
    return { web: this.sifalo || this.dev, starsPerUsd: this.rate, topups: TOPUPS.map((d) => ({ usd: d, stars: d * this.rate })), support: this.support };
  }

  catalogPublic() {
    return { config: this.publicConfig(), categories: CATEGORIES, products: this.catalog() };
  }

  stateFor(user) {
    return {
      me: this.get('SELECT id,name,username,balance FROM users WHERE id=?', user.id),
      config: this.publicConfig(),
      categories: CATEGORIES,
      products: this.catalog(),
      orders: this.all(`SELECT o.id, o.price, o.stars, o.method, o.status, o.delivery, o.created,
          pr.name AS product, pr.color, pr.glyph, pl.label AS plan
        FROM orders o JOIN plans pl ON pl.id=o.plan_id JOIN products pr ON pr.id=pl.product_id
        WHERE o.user_id=? AND (o.status!='awaiting' OR o.created>?) ORDER BY o.id DESC LIMIT 50`, user.id, now() - 600),
      ledger: this.all('SELECT id, delta, note, created FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 30', user.id),
    };
  }

  /* ───────── الطلبات والتسليم ───────── */
  insertOrder(userId, plan, method, status, stars = null) {
    return this.get('INSERT INTO orders(user_id,plan_id,price,stars,method,status,created,updated) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
      userId, plan.id, plan.price, stars, method, status, now(), now()).id;
  }

  // يُستدعى داخل معاملة. الطلب بحالة paid → delivered أو pending أو refunded.
  fulfillTx(orderId) {
    const o = this.get('SELECT * FROM orders WHERE id=?', orderId);
    if (!o || o.status !== 'paid') return null;
    const plan = this.planRow(o.plan_id);
    const s = this.get('SELECT id, content FROM stock WHERE plan_id=? AND order_id IS NULL ORDER BY id LIMIT 1', o.plan_id);
    let status;
    let delivery = null;
    if (s) {
      this.run('UPDATE stock SET order_id=? WHERE id=?', o.id, s.id);
      status = 'delivered';
      delivery = s.content;
    } else if (plan?.manual) {
      status = 'pending';
    } else {
      status = 'refunded';
      this.addBalance(o.user_id, o.price, `استرداد ${plan?.product ?? 'طلب'} (نفد المخزون)`);
    }
    this.run('UPDATE orders SET status=?, delivery=?, updated=? WHERE id=?', status, delivery, now(), o.id);
    return { orderId: o.id, userId: o.user_id, status, delivery, product: plan?.product, plan: plan?.label, price: o.price };
  }

  async notifyOrder(r) {
    if (!r) return;
    const title = `${esc(r.product)} — ${esc(r.plan)}`;
    if (r.status === 'delivered') {
      await this.say(r.userId, `✅ تم تسليم طلبك #${r.orderId}\n<b>${title}</b>\n\n<code>${esc(r.delivery)}</code>`);
    } else if (r.status === 'pending') {
      await this.say(r.userId, `⏳ استلمنا طلبك #${r.orderId}\n<b>${title}</b>\nنجهّز اشتراكك وسيصلك هنا فور الانتهاء.`);
      await this.tellAdmins(`🔔 طلب يحتاج تسليم يدوي #${r.orderId}\n${title}\nالعميل: <code>${r.userId}</code>\n\n/deliver ${r.orderId} النص`);
    } else if (r.status === 'refunded') {
      await this.say(r.userId, `نفد مخزون ${title}. أضفنا ${usd(r.price)} إلى محفظتك.`);
    }
  }

  async buy(user, { plan_id, method }) {
    const plan = this.planRow(Number(plan_id));
    if (!plan) throw httpErr(404, 'هذه الباقة لم تعد موجودة');
    if (!this.isAvailable(plan)) throw httpErr(409, 'نفدت الكمية حاليًا. جرّب لاحقًا');

    if (method === 'wallet') {
      const result = this.tx(() => {
        const r = this.all('UPDATE users SET balance=balance-? WHERE id=? AND balance>=? RETURNING id', plan.price, user.id, plan.price);
        if (!r.length) throw httpErr(402, 'رصيد المحفظة لا يكفي. اشحن المحفظة أولًا');
        const orderId = this.insertOrder(user.id, plan, 'wallet', 'paid');
        this.run('INSERT INTO ledger(user_id,delta,note,created) VALUES (?,?,?,?)', user.id, -plan.price, `شراء ${plan.product} — ${plan.label}`, now());
        return this.fulfillTx(orderId);
      });
      await this.notifyOrder(result);
      return { order_id: result.orderId };
    }
    if (method === 'stars') {
      if (user.id >= WEB_BASE) throw httpErr(400, 'الدفع بالنجوم متاح داخل تيليجرام فقط');
      const stars = this.starsFor(plan.price);
      const orderId = this.insertOrder(user.id, plan, 'stars', 'awaiting', stars);
      const invoice = await this.createInvoice({ title: plan.product.slice(0, 32), description: plan.label, payload: `o:${orderId}`, stars });
      return { order_id: orderId, invoice };
    }
    throw httpErr(400, 'طريقة الدفع غير معروفة');
  }

  async topup(user, { usd: amount }) {
    if (user.id >= WEB_BASE) throw httpErr(400, 'الشحن بالنجوم داخل تيليجرام فقط. استخدم الشحن بالبطاقة');
    if (!TOPUPS.includes(Number(amount))) throw httpErr(400, 'باقة الشحن غير صحيحة');
    const invoice = await this.createInvoice({
      title: 'شحن المحفظة', description: `إضافة $${amount} إلى رصيدك`, payload: `t:${user.id}:${amount}`, stars: Number(amount) * this.rate,
    });
    return { invoice };
  }

  async createInvoice({ title, description, payload, stars }) {
    if (!this.token && this.dev) return `dev:${payload}:${stars}`;
    // النجوم: العملة XTR بدون provider_token وعنصر واحد في prices
    return this.tg('createInvoiceLink', { title, description, payload, currency: 'XTR', prices: [{ label: title, amount: stars }] });
  }

  /* ───────── معالجة الدفع بالنجوم ───────── */
  processPayment(fromId, sp) {
    if (sp.currency !== 'XTR') return null;
    const stars = sp.total_amount;
    const [kind, a] = String(sp.invoice_payload).split(':');
    return this.tx(() => {
      const first = this.all('INSERT OR IGNORE INTO payments(charge_id,user_id,payload,stars,created) VALUES (?,?,?,?,?) RETURNING charge_id',
        sp.telegram_payment_charge_id, fromId, sp.invoice_payload, stars, now());
      if (!first.length) return { dup: true };

      // الرصيد دائمًا بحسب النجوم المدفوعة فعلًا، فلا يضيع مال العميل حتى لو تغيّر السعر
      if (kind === 't') {
        const cents = this.centsFor(stars);
        this.addBalance(fromId, cents, `شحن بالنجوم — ${stars} نجمة`);
        return { kind: 'topup', userId: fromId, cents, stars };
      }
      if (kind === 'o') {
        const o = this.get('SELECT * FROM orders WHERE id=?', Number(a));
        if (o && o.user_id === fromId && o.status === 'awaiting' && o.stars === stars) {
          this.run("UPDATE orders SET status='paid', updated=? WHERE id=?", now(), o.id);
          return { kind: 'order', result: this.fulfillTx(o.id) };
        }
        const cents = this.centsFor(stars);
        this.addBalance(fromId, cents, `استرداد دفعة بالنجوم — ${stars} نجمة`);
        return { kind: 'credited', userId: fromId, cents };
      }
      return { dup: true };
    });
  }

  async afterPayment(o) {
    if (!o || o.dup) return;
    if (o.kind === 'topup') await this.say(o.userId, `✅ تمت إضافة ${usd(o.cents)} إلى محفظتك (${o.stars} نجمة).`);
    else if (o.kind === 'order') await this.notifyOrder(o.result);
    else if (o.kind === 'credited') {
      await this.say(o.userId, `تعذّر إكمال الطلب بعد الدفع، فأضفنا ${usd(o.cents)} إلى محفظتك.`);
      await this.tellAdmins(`⚠️ دفعة بالنجوم لم تطابق طلبًا وتم تحويلها لمحفظة <code>${o.userId}</code> (${usd(o.cents)}).`);
    }
  }

  /* ───────── لوحة الإدارة (/admin) ───────── */
  async adminLogin({ password }) {
    if (!this.adminPassword) throw httpErr(503, 'لم تُضبط كلمة سر الإدارة (ADMIN_PASSWORD) في Cloudflare بعد');
    const f = this.get("SELECT * FROM login_fail WHERE email='__admin__'");
    if (f && f.until > now()) throw httpErr(429, 'محاولات كثيرة. حاول بعد 15 دقيقة');
    const same = safeEqual(await sha256hex(String(password || '')), await sha256hex(this.adminPassword));
    if (!same) {
      const n = (f?.n || 0) + 1;
      this.run("INSERT INTO login_fail(email,n,until) VALUES ('__admin__',?,?) ON CONFLICT(email) DO UPDATE SET n=excluded.n, until=excluded.until", n >= 5 ? 0 : n, n >= 5 ? now() + 900 : 0);
      throw httpErr(401, 'كلمة السر غير صحيحة');
    }
    this.run("DELETE FROM login_fail WHERE email='__admin__'");
    return { token: await this.newSession(-1, 12 * 3600) };
  }

  async requireAdmin(request) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') || '');
    const row = m && this.get('SELECT user_id FROM web_sessions WHERE token_hash=? AND expires>?', await sha256hex(m[1]), now());
    if (!row || row.user_id !== -1) throw httpErr(401, 'انتهت جلسة الإدارة. سجّل الدخول من جديد');
    return m[1];
  }

  userLabel(r) { return r.email || (r.username ? `@${r.username}` : r.name) || `#${r.user_id ?? r.id}`; }

  async admin(route, request, url, body) {
    if (route === '/login') return this.adminLogin(body);
    const token = await this.requireAdmin(request);
    const usd2c = (v) => { const c = Math.round(Number(v) * 100); if (!Number.isFinite(c)) throw httpErr(400, 'اكتب رقمًا صحيحًا'); return c; };
    const g = (sql, ...p) => this.get(sql, ...p).n;

    if (route === '/logout') { this.run('DELETE FROM web_sessions WHERE token_hash=?', await sha256hex(token)); return { ok: true }; }

    if (route === '/sifalo/test') {
      if (!this.sifalo) throw httpErr(400, 'مفاتيح Sifalo غير مضافة في Cloudflare');
      const h = this.sifaloHosts();
      let r = null; let txt = '';
      try {
        r = await fetch(h.api, { method: 'POST', headers: { authorization: this.sifaloAuth(), 'content-type': 'application/json' },
          body: JSON.stringify({ amount: '1', gateway: 'checkout', currency: 'USD', return_url: `${new URL(request.url).origin}/?topup=test&order_id=test` }) });
        txt = await r.text();
      } catch (e) { txt = 'network: ' + e.message; }
      let j = null; try { j = JSON.parse(txt); } catch {}
      const ok = !!(r?.ok && (j?.key ?? j?.data?.key) && (j?.token ?? j?.data?.token));
      const mask = (v) => (v ? String(v).slice(0, 4) + '…' : v);
      const safe = j && typeof j === 'object' ? JSON.stringify({ ...j, key: mask(j.key), token: mask(j.token), data: undefined }) : txt.slice(0, 300);
      return { ok, status: r?.status ?? 0, env: this.staging ? 'staging' : 'live', host: h.api, user: this.sifaloUser.slice(0, 5) + '…', response: safe.slice(0, 400) };
    }

    if (route === '/overview') {
      const day = now() - 86400;
      return {
        users: g('SELECT COUNT(*) n FROM users'),
        webUsers: g('SELECT COUNT(*) n FROM web_accounts'),
        orders: {
          pending: g("SELECT COUNT(*) n FROM orders WHERE status='pending'"),
          delivered: g("SELECT COUNT(*) n FROM orders WHERE status='delivered'"),
          refunded: g("SELECT COUNT(*) n FROM orders WHERE status='refunded'"),
          today: g("SELECT COUNT(*) n FROM orders WHERE status IN ('pending','delivered') AND created>?", day),
        },
        salesCents: g("SELECT COALESCE(SUM(price),0) n FROM orders WHERE status IN ('pending','delivered')"),
        salesTodayCents: g("SELECT COALESCE(SUM(price),0) n FROM orders WHERE status IN ('pending','delivered') AND created>?", day),
        topupsCents: g("SELECT COALESCE(SUM(cents),0) n FROM topups WHERE status='paid'"),
        stars: g('SELECT COALESCE(SUM(stars),0) n FROM payments'),
        walletsCents: g('SELECT COALESCE(SUM(balance),0) n FROM users'),
        pendingTopups: g("SELECT COUNT(*) n FROM topups WHERE status='pending' AND gw_key!='' AND created>?", day),
        lowStock: this.all(`SELECT pl.id, pr.name, pl.label,
            (SELECT COUNT(*) FROM stock s WHERE s.plan_id=pl.id AND s.order_id IS NULL) AS stock
          FROM plans pl JOIN products pr ON pr.id=pl.product_id
          WHERE pl.active=1 AND pr.active=1 AND pl.manual=0 AND stock<=2 ORDER BY stock, pl.id`),
        sifalo: this.sifalo, staging: this.staging, telegram: !!this.token,
      };
    }

    if (route === '/orders') {
      const st = ['pending', 'delivered', 'refunded'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : '';
      return { orders: this.all(`SELECT o.id, o.user_id, o.price, o.method, o.status, o.delivery, o.created, pr.name AS product, pl.label AS plan,
          u.name, u.username, wa.email
        FROM orders o JOIN plans pl ON pl.id=o.plan_id JOIN products pr ON pr.id=pl.product_id
        LEFT JOIN users u ON u.id=o.user_id LEFT JOIN web_accounts wa ON wa.user_id=o.user_id
        WHERE o.status!='awaiting' AND (?='' OR o.status=?) ORDER BY o.id DESC LIMIT 100`, st, st) .map((r) => ({ ...r, who: this.userLabel(r) })) };
    }

    if (route === '/deliver') {
      const id = Number(body.id);
      const text = String(body.text || '').trim().slice(0, 2000);
      const o = this.get("SELECT * FROM orders WHERE id=? AND status='pending'", id);
      if (!o) throw httpErr(404, 'الطلب غير موجود أو ليس بانتظار التسليم');
      if (!text) throw httpErr(400, 'اكتب بيانات الاشتراك التي تُسلَّم للعميل');
      this.run("UPDATE orders SET status='delivered', delivery=?, updated=? WHERE id=?", text, now(), id);
      const pl = this.planRow(o.plan_id);
      await this.notifyOrder({ orderId: id, userId: o.user_id, status: 'delivered', delivery: text, product: pl?.product, plan: pl?.label });
      return { ok: true };
    }

    if (route === '/refund') {
      const o = this.get('SELECT * FROM orders WHERE id=?', Number(body.id));
      if (!o || !['pending', 'delivered'].includes(o.status)) throw httpErr(400, 'هذا الطلب لا يمكن استرداده');
      if (o.method !== 'wallet') throw httpErr(400, 'طلبات النجوم تُسترد من تيليجرام بالأمر /refund');
      this.tx(() => {
        this.addBalance(o.user_id, o.price, `استرداد الطلب #${o.id}`);
        this.run("UPDATE orders SET status='refunded', updated=? WHERE id=?", now(), o.id);
      });
      await this.say(o.user_id, `تم استرداد طلبك #${o.id} إلى محفظتك.`);
      return { ok: true };
    }

    if (route === '/catalog') {
      const plans = this.all(`SELECT pl.*, (SELECT COUNT(*) FROM stock s WHERE s.plan_id=pl.id AND s.order_id IS NULL) AS stock FROM plans pl ORDER BY pl.id`);
      return {
        categories: CATEGORIES,
        products: this.all('SELECT * FROM products ORDER BY sort, id').map((p) => ({
          id: p.id, name: p.name, cat: p.cat, color: p.color, glyph: p.glyph, desc: p.descr, active: p.active,
          plans: plans.filter((x) => x.product_id === p.id).map((x) => ({ id: x.id, label: x.label, price: x.price, manual: x.manual, active: x.active, stock: x.stock })),
        })),
      };
    }

    if (route === '/plan/update') {
      const pl = this.get('SELECT * FROM plans WHERE id=?', Number(body.id));
      if (!pl) throw httpErr(404, 'الباقة غير موجودة');
      const price = body.price !== undefined ? usd2c(body.price) : pl.price;
      if (price <= 0 || price > 1000000) throw httpErr(400, 'السعر غير صحيح');
      const label = body.label !== undefined ? String(body.label).trim().slice(0, 60) : pl.label;
      if (!label) throw httpErr(400, 'اسم الباقة فارغ');
      this.run('UPDATE plans SET price=?, label=?, active=?, manual=? WHERE id=?', price, label,
        body.active !== undefined ? (body.active ? 1 : 0) : pl.active, body.manual !== undefined ? (body.manual ? 1 : 0) : pl.manual, pl.id);
      return { ok: true };
    }

    if (route === '/product/update') {
      const p = this.get('SELECT * FROM products WHERE id=?', Number(body.id));
      if (!p) throw httpErr(404, 'المنتج غير موجود');
      const name = body.name !== undefined ? String(body.name).trim().slice(0, 60) : p.name;
      if (!name) throw httpErr(400, 'اسم المنتج فارغ');
      this.run('UPDATE products SET name=?, descr=?, active=? WHERE id=?', name,
        body.desc !== undefined ? String(body.desc).trim().slice(0, 200) : p.descr, body.active !== undefined ? (body.active ? 1 : 0) : p.active, p.id);
      return { ok: true };
    }

    if (route === '/product/add') {
      const name = String(body.name || '').trim().slice(0, 60);
      const glyph = String(body.glyph || '').trim().slice(0, 2);
      if (!name || !glyph) throw httpErr(400, 'اكتب اسم المنتج ورمزه (حرف أو حرفان)');
      if (!CATEGORIES.some((c) => c.key === body.cat)) throw httpErr(400, 'اختر تصنيفًا');
      if (!/^#[0-9a-fA-F]{6}$/.test(String(body.color || ''))) throw httpErr(400, 'اللون يكتب هكذا: #FF5577');
      const sort = g('SELECT COALESCE(MAX(sort),0)+1 n FROM products');
      const r = this.get('INSERT INTO products(name,cat,color,glyph,descr,sort) VALUES (?,?,?,?,?,?) RETURNING id', name, body.cat, body.color, glyph, String(body.desc || '').trim().slice(0, 200), sort);
      return { id: r.id };
    }

    if (route === '/plan/add') {
      const label = String(body.label || '').trim().slice(0, 60);
      const price = usd2c(body.price);
      if (!this.get('SELECT 1 AS x FROM products WHERE id=?', Number(body.product_id))) throw httpErr(404, 'المنتج غير موجود');
      if (!label || price <= 0) throw httpErr(400, 'اكتب اسم الباقة وسعرها');
      const r = this.get('INSERT INTO plans(product_id,label,price,manual) VALUES (?,?,?,?) RETURNING id', Number(body.product_id), label, price, body.manual ? 1 : 0);
      return { id: r.id };
    }

    if (route === '/stock') {
      const lines = String(body.lines || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 500);
      if (!this.get('SELECT 1 AS x FROM plans WHERE id=?', Number(body.plan_id))) throw httpErr(404, 'الباقة غير موجودة');
      if (!lines.length) throw httpErr(400, 'اكتب عنصرًا واحدًا على الأقل، كل سطر لعميل');
      this.tx(() => { for (const c of lines) this.run('INSERT INTO stock(plan_id,content) VALUES (?,?)', Number(body.plan_id), c.slice(0, 1000)); });
      return { added: lines.length };
    }

    if (route === '/users') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
      const like = `%${q.replace(/[%_]/g, '')}%`;
      return { users: this.all(`SELECT u.id, u.name, u.username, u.balance, u.created, wa.email,
          (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id AND o.status IN ('pending','delivered')) AS orders
        FROM users u LEFT JOIN web_accounts wa ON wa.user_id=u.id
        WHERE ?='' OR u.name LIKE ? OR wa.email LIKE ? OR u.username LIKE ? OR CAST(u.id AS TEXT)=? ORDER BY u.created DESC LIMIT 50`, q, like, like, like, q)
        .map((r) => ({ ...r, label: this.userLabel(r) })) };
    }

    if (route === '/credit') {
      const uid = Number(body.user_id);
      const cents = usd2c(body.amount);
      if (!cents || Math.abs(cents) > 10000000) throw httpErr(400, 'المبلغ غير صحيح');
      const u = this.get('SELECT * FROM users WHERE id=?', uid);
      if (!u) throw httpErr(404, 'المستخدم غير موجود');
      if (cents < 0 && u.balance + cents < 0) throw httpErr(400, 'الخصم أكبر من رصيد العميل');
      const note = String(body.note || '').trim().slice(0, 80);
      this.tx(() => this.addBalance(uid, cents, note || (cents > 0 ? 'رصيد من الإدارة' : 'خصم من الإدارة')));
      await this.say(uid, `تم تعديل رصيد محفظتك: ${cents > 0 ? '+' : '−'}${usd(Math.abs(cents))}`);
      return { balance: this.get('SELECT balance FROM users WHERE id=?', uid).balance };
    }

    if (route === '/topups') {
      return { topups: this.all(`SELECT t.ref, t.user_id, t.cents, t.status, t.created, t.sid, u.name, u.username, wa.email
        FROM topups t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN web_accounts wa ON wa.user_id=t.user_id
        WHERE t.gw_key!='' ORDER BY t.created DESC LIMIT 60`).map((r) => ({ ...r, who: this.userLabel(r) })) };
    }

    if (route === '/topup/verify') {
      const t = this.get("SELECT * FROM topups WHERE ref=? AND gw_key!=''", String(body.ref || ''));
      if (!t) throw httpErr(404, 'الشحنة غير موجودة');
      await this.settleTopups(this.get('SELECT * FROM users WHERE id=?', t.user_id), t.ref);
      return { status: this.get('SELECT status FROM topups WHERE ref=?', t.ref).status };
    }

    if (route === '/topup/credit') { // إضافة يدوية بعد أن تتأكد بنفسك من وصول المبلغ في لوحة Sifalo
      const t = this.get("SELECT * FROM topups WHERE ref=? AND status IN ('pending','failed')", String(body.ref || ''));
      if (!t) throw httpErr(404, 'الشحنة غير موجودة أو مكتملة');
      this.run("UPDATE topups SET status='pending' WHERE ref=?", t.ref);
      const done = this.creditTopup({ ...t, status: 'pending' }, `manual_${t.ref}`, `شحن (إضافة يدوية) — $${t.cents / 100}`);
      if (done) await this.say(t.user_id, `تمت إضافة ${usd(t.cents)} إلى محفظتك.`);
      return { ok: done };
    }

    throw httpErr(404, 'غير موجود');
  }

  /* ───────── البوت (Webhook) ───────── */
  async handleUpdate(u, origin) {
    if (u.pre_checkout_query) {
      const q = u.pre_checkout_query;
      let ok = true;
      let error_message;
      const [kind, a] = String(q.invoice_payload).split(':');
      if (kind === 'o') {
        const o = this.get('SELECT * FROM orders WHERE id=?', Number(a));
        const pl = o && this.planRow(o.plan_id);
        if (!o || o.status !== 'awaiting' || !pl || !this.isAvailable(pl)) {
          ok = false;
          error_message = 'نفدت الكمية أو انتهى الطلب. افتح المتجر وأعد المحاولة';
        }
      }
      await this.tg('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok, ...(ok ? {} : { error_message }) });
      return;
    }
    const m = u.message;
    if (!m) return;
    if (m.successful_payment) {
      this.upsertUser(m.from);
      await this.afterPayment(this.processPayment(m.from.id, m.successful_payment));
      return;
    }
    if (m.text?.startsWith('/')) await this.command(m, origin);
  }

  isAdmin(id) { return this.admins.includes(id); }

  async command(m, origin) {
    const lines = m.text.split('\n');
    const [head, ...args] = lines[0].trim().split(/\s+/);
    const cmd = head.split('@')[0].toLowerCase();
    const chat = m.chat.id;
    const say = (t, x) => this.say(chat, t, x);

    if (cmd === '/start') {
      this.upsertUser(m.from);
      return say('أهلًا بك في المتجر.\nاشترك في خدماتك المفضلة، وادفع بالنجوم أو من محفظتك.',
        { reply_markup: { inline_keyboard: [[{ text: 'افتح المتجر', web_app: { url: origin } }]] } });
    }
    if (cmd === '/paysupport') {
      return say(this.support ? `لأي مشكلة في الدفع أو الطلبات تواصل مع @${this.support} وأرسل رقم الطلب.` : 'لأي مشكلة في الدفع أرسل رقم طلبك هنا وسنراجعه.');
    }
    if (!this.isAdmin(m.from.id)) return;

    if (cmd === '/stats') {
      const g = (sql) => this.get(sql).n;
      return say(
        `المستخدمون: ${g('SELECT COUNT(*) n FROM users')}\n` +
        `الطلبات المسلّمة: ${g("SELECT COUNT(*) n FROM orders WHERE status='delivered'")}\n` +
        `بانتظار التسليم: ${g("SELECT COUNT(*) n FROM orders WHERE status='pending'")}\n` +
        `نجوم مستلمة: ${g('SELECT COALESCE(SUM(stars),0) n FROM payments')} ★`);
    }
    if (cmd === '/plans') {
      const rows = this.all(`SELECT pl.id, pl.active AS pa, pr.id AS pid, pr.name, pr.active AS pra, pl.label, pl.price, pl.manual,
        (SELECT COUNT(*) FROM stock s WHERE s.plan_id=pl.id AND s.order_id IS NULL) AS stock
        FROM plans pl JOIN products pr ON pr.id=pl.product_id ORDER BY pr.sort, pr.id, pl.id`);
      return say(rows.map((r) => `باقة <code>${r.id}</code> | منتج <code>${r.pid}</code> ${esc(r.name)} — ${esc(r.label)} (${usd(r.price)}) ` +
        `مخزون ${r.stock}${r.manual ? ' يدوي' : ''}${r.pa && r.pra ? '' : ' [مخفي]'}`).join('\n'));
    }
    if (cmd === '/addstock') {
      const planId = Number(args[0]);
      const items = lines.slice(1).map((l) => l.trim()).filter(Boolean);
      if (!planId || !items.length || !this.get('SELECT 1 AS x FROM plans WHERE id=?', planId)) return say('الصيغة:\n/addstock رقم_الباقة\nكل سطر بعده = حساب أو كود');
      this.tx(() => { for (const c of items) this.run('INSERT INTO stock(plan_id,content) VALUES (?,?)', planId, c); });
      return say(`أُضيف ${items.length} عنصر إلى الباقة ${planId}.`);
    }
    if (cmd === '/setprice') {
      const cents = Math.round(Number(args[1]) * 100);
      const r = cents > 0 && this.all('UPDATE plans SET price=? WHERE id=? RETURNING id', cents, Number(args[0]));
      return say(r?.length ? `تم: سعر الباقة ${args[0]} صار ${usd(cents)}.` : 'الصيغة: /setprice رقم_الباقة السعر_بالدولار');
    }
    if (cmd === '/addplan') { // /addplan رقم_المنتج السعر يدوي(0/1) الاسم...
      const [pid, price, manual, ...label] = args;
      const cents = Math.round(Number(price) * 100);
      if (!this.get('SELECT 1 AS x FROM products WHERE id=?', Number(pid)) || !(cents > 0) || !['0', '1'].includes(manual) || !label.length) {
        return say('الصيغة: /addplan رقم_المنتج السعر_بالدولار يدوي(1)_أو_مخزون(0) اسم الباقة\nمثال: /addplan 3 12.5 1 6 أشهر');
      }
      const r = this.get('INSERT INTO plans(product_id,label,price,manual) VALUES (?,?,?,?) RETURNING id', Number(pid), label.join(' '), cents, Number(manual));
      return say(`أُضيفت الباقة رقم ${r.id}.`);
    }
    if (cmd === '/addproduct') { // /addproduct الاسم|التصنيف|#لون|رمز|الوصف
      const [name, cat, color, glyph, desc] = lines[0].replace(/^\S+\s*/, '').split('|').map((s) => s.trim());
      if (!name || !CATEGORIES.some((c) => c.key === cat) || !/^#[0-9a-fA-F]{6}$/.test(color || '') || !glyph) {
        return say(`الصيغة: /addproduct الاسم|التصنيف|#لون|رمز|الوصف\nالتصنيفات: ${CATEGORIES.map((c) => c.key).join(', ')}\nمثال: /addproduct Max|video|#FF5577|M|وصف قصير`);
      }
      const sort = (this.get('SELECT COALESCE(MAX(sort),0)+1 AS n FROM products').n);
      const r = this.get('INSERT INTO products(name,cat,color,glyph,descr,sort) VALUES (?,?,?,?,?,?) RETURNING id', name, cat, color, glyph.slice(0, 2), desc || '', sort);
      return say(`أُضيف المنتج رقم ${r.id}. الآن أضف له باقات بالأمر /addplan ${r.id} ...`);
    }
    if (cmd === '/hide' || cmd === '/show') { // /hide plan|product رقم
      const table = { plan: 'plans', product: 'products' }[args[0]];
      const r = table && this.all(`UPDATE ${table} SET active=? WHERE id=? RETURNING id`, cmd === '/show' ? 1 : 0, Number(args[1]));
      return say(r?.length ? 'تم.' : `الصيغة: ${cmd} plan|product الرقم`);
    }
    if (cmd === '/pending') {
      const rows = this.all(`SELECT o.id, o.user_id, pr.name, pl.label FROM orders o
        JOIN plans pl ON pl.id=o.plan_id JOIN products pr ON pr.id=pl.product_id WHERE o.status='pending' ORDER BY o.id`);
      return say(rows.length ? rows.map((r) => `#${r.id} ${esc(r.name)} — ${esc(r.label)} (<code>${r.user_id}</code>)`).join('\n') : 'لا توجد طلبات معلّقة.');
    }
    if (cmd === '/deliver') {
      const id = Number(args[0]);
      const text = m.text.replace(/^\S+\s+\d+\s*/, '').trim();
      const o = this.get("SELECT * FROM orders WHERE id=? AND status='pending'", id);
      if (!o || !text) return say('الصيغة:\n/deliver رقم_الطلب النص\nويجب أن يكون الطلب معلّقًا.');
      this.run("UPDATE orders SET status='delivered', delivery=?, updated=? WHERE id=?", text, now(), id);
      const pl = this.planRow(o.plan_id);
      await this.notifyOrder({ orderId: id, userId: o.user_id, status: 'delivered', delivery: text, product: pl?.product, plan: pl?.label });
      return say(`تم تسليم الطلب #${id}.`);
    }
    if (cmd === '/credit') {
      const uid = Number(args[0]);
      const amount = Math.round(Number(args[1]) * 100);
      if (!uid || !amount || !this.get('SELECT 1 AS x FROM users WHERE id=?', uid)) return say('الصيغة: /credit معرّف_المستخدم المبلغ_بالدولار');
      this.tx(() => this.addBalance(uid, amount, amount > 0 ? 'رصيد من الإدارة' : 'خصم من الإدارة'));
      await this.say(uid, `تم تعديل رصيد محفظتك: ${amount > 0 ? '+' : '−'}${usd(Math.abs(amount))}`);
      return say('تم.');
    }
    if (cmd === '/refund') {
      const o = this.get('SELECT * FROM orders WHERE id=?', Number(args[0]));
      if (!o || !['pending', 'delivered'].includes(o.status)) return say('الصيغة: /refund رقم_الطلب (طلب مدفوع غير مسترد)');
      if (o.method === 'stars') {
        const pay = this.get('SELECT charge_id FROM payments WHERE payload=?', `o:${o.id}`);
        if (!pay) return say('لا توجد دفعة مرتبطة بهذا الطلب.');
        await this.tg('refundStarPayment', { user_id: o.user_id, telegram_payment_charge_id: pay.charge_id });
      } else {
        this.tx(() => this.addBalance(o.user_id, o.price, `استرداد الطلب #${o.id}`));
      }
      this.run("UPDATE orders SET status='refunded', updated=? WHERE id=?", now(), o.id);
      await this.say(o.user_id, `تم استرداد طلبك #${o.id}.`);
      return say(`تم استرداد الطلب #${o.id}.`);
    }
  }

  /* ───────── نقطة الدخول ───────── */
  async fetch(request) {
    const url = new URL(request.url);
    try {
      // ربط البوت بهذا الرابط (مرة واحدة): افتح /setup/<WEBHOOK_SECRET> في المتصفح
      if (url.pathname.startsWith('/setup/')) {
        const secret = this.env.WEBHOOK_SECRET || '';
        if (!secret || decodeURIComponent(url.pathname.slice(7)) !== secret) return json({ error: 'غير مصرّح' }, 403);
        await this.tg('setWebhook', {
          url: `${url.origin}/tg`, secret_token: secret, allowed_updates: ['message', 'pre_checkout_query'], drop_pending_updates: true,
        });
        await this.tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'المتجر', web_app: { url: url.origin } } });
        await this.tg('setMyCommands', { commands: [{ command: 'start', description: 'فتح المتجر' }, { command: 'paysupport', description: 'مشاكل الدفع' }] });
        return json({ ok: true, store: url.origin, note: 'تم ربط البوت. افتحه في تيليجرام وأرسل /start' });
      }

      // استقبال تحديثات تيليجرام
      if (url.pathname === '/tg' && request.method === 'POST') {
        if (!this.env.WEBHOOK_SECRET || request.headers.get('x-telegram-bot-api-secret-token') !== this.env.WEBHOOK_SECRET) {
          return new Response('forbidden', { status: 403 });
        }
        try { await this.handleUpdate(await request.json(), url.origin); } catch (e) { console.error('update', e); }
        return new Response('ok'); // دائمًا 200 حتى لا يعيد تيليجرام الإرسال
      }

      // واجهة المتجر
      if (url.pathname.startsWith('/api/')) {
        const route = url.pathname.slice(4);
        const body = async () => { try { return await request.json(); } catch { throw httpErr(400, 'طلب غير صالح'); } };
        if (route.startsWith('/admin/')) return json(await this.admin(route.slice(6), request, url, request.method === 'GET' ? {} : await body()));
        if (request.method === 'GET' && route === '/catalog') return json(this.catalogPublic());
        if (request.method === 'POST' && route === '/web/signup') return json(await this.signup(await body()));
        if (request.method === 'POST' && route === '/web/login') return json(await this.login(await body()));
        const user = await this.auth(request);
        if (request.method === 'POST' && route === '/web/logout') return json(await this.logout(request));
        if (request.method === 'POST' && route === '/web/topup') return json(await this.webTopup(user, url.origin, await body()));
        if (request.method === 'POST' && route === '/web/topup/check') {
          const { ref } = await body();
          await this.settleTopups(user, String(ref || ''));
          const t = this.get('SELECT status, cents FROM topups WHERE ref=? AND user_id=?', String(ref || ''), user.id);
          return json({ status: t?.status || 'none', cents: t?.cents || 0 });
        }
        if (request.method === 'GET' && route === '/state') {
          if (user.id >= WEB_BASE) await this.settleTopups(user);
          return json(this.stateFor(user));
        }
        if (request.method === 'POST' && route === '/buy') return json(await this.buy(user, await body()));
        if (request.method === 'POST' && route === '/topup') return json(await this.topup(user, await body()));
        if (this.dev && !this.token && request.method === 'POST' && route === '/dev/pay') {
          const b = await body();
          const o = this.processPayment(user.id, {
            currency: 'XTR', invoice_payload: b.payload, total_amount: Number(b.stars),
            telegram_payment_charge_id: `dev_${crypto.randomUUID()}`,
          });
          await this.afterPayment(o);
          return json({ ok: true });
        }
      }
      return json({ error: 'غير موجود' }, 404);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? 'حدث خطأ غير متوقع. حاول مرة أخرى' : e.message }, status);
    }
  }
}

/* ───────── الواجهة (ملفات ثابتة مدمجة) ───────── */
const ASSETS = {"/index.html":{"type":"text/html; charset=utf-8","body":"<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n  <meta name=\"theme-color\" content=\"#ffffff\">\n  <meta name=\"description\" content=\"متجر اشتراكات رقمية: نتفليكس وشاهد وسبوتيفاي وChatGPT وغيرها. ادفع بالبطاقة واستلم اشتراكك بسرعة.\">\n  <title>متجر الاشتراكات الرقمية</title>\n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n  <link href=\"https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@300;400;500;600;700&display=swap\" rel=\"stylesheet\">\n  <link rel=\"stylesheet\" href=\"/app.css\">\n</head>\n<body>\n  <div id=\"app\"><div class=\"boot\"><span class=\"spin\"></span></div></div>\n  <div id=\"overlay\" hidden></div>\n  <div id=\"toast\" role=\"status\" aria-live=\"polite\"></div>\n  <script src=\"/app.js\"></script>\n</body>\n</html>\n"},"/app.css":{"type":"text/css; charset=utf-8","body":":root {\n  --bg: #f6f7f9; --surface: #fff; --ink: #0f172a; --ink2: #475569; --ink3: #8592a6; --line: #e5e9f0;\n  --brand: #0b7a75; --brand-d: #086561; --brand-l: #e3f4f2; --accent: #f59e0b;\n  --ok: #15803d; --ok-bg: #e7f6ec; --warn: #b45309; --warn-bg: #fdf2dd; --bad: #b91c1c; --bad-bg: #fde8e8;\n  --r: 14px; --shadow: 0 1px 2px rgba(15,23,42,.05), 0 6px 22px rgba(15,23,42,.06);\n  --wrap: 1180px;\n}\n* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }\nhtml { scroll-behavior: smooth; }\nbody { margin: 0; background: var(--bg); color: var(--ink); font: 400 15px/1.7 'IBM Plex Sans Arabic', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }\nbutton, input, select { font: inherit; color: inherit; }\nbutton { cursor: pointer; }\na { color: inherit; text-decoration: none; }\nh1, h2, h3, p { margin: 0; }\nh1, h2, h3 { text-wrap: balance; line-height: 1.35; }\nbdi, .ltr { unicode-bidi: isolate; }\n.wrap { max-width: var(--wrap); margin: 0 auto; padding-inline: max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-left, 0px)); }\n.boot { min-height: 100vh; display: grid; place-items: center; }\n.spin { width: 22px; height: 22px; border: 3px solid currentColor; border-inline-end-color: transparent; border-radius: 50%; display: inline-block; animation: sp .7s linear infinite; vertical-align: middle; }\n@keyframes sp { to { transform: rotate(360deg); } }\n.ico { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }\n:focus-visible { outline: 3px solid color-mix(in srgb, var(--brand) 45%, transparent); outline-offset: 2px; }\n\n/* شريط الإعلان */\n.announce { background: var(--ink); color: #e8edf5; font-size: 13px; text-align: center; padding: 8px 12px; }\n.announce b { color: #ffd479; font-weight: 600; }\n\n/* الهيدر */\n.header { background: var(--surface); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 30; }\n.hrow { display: flex; align-items: center; gap: 14px; padding-block: 12px; }\n.logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; flex: none; }\n.logo i { width: 38px; height: 38px; border-radius: 11px; background: linear-gradient(140deg, var(--brand), #14b8a6); color: #fff; display: grid; place-items: center; font-style: normal; font-size: 19px; box-shadow: 0 4px 12px rgba(11,122,117,.3); }\n.search { flex: 1; position: relative; max-width: 560px; margin-inline: auto; }\n.search input { width: 100%; height: 44px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg); padding-inline: 44px 14px; outline: none; transition: border-color .15s, background .15s; }\n.search input:focus { border-color: var(--brand); background: #fff; }\n.search .ico { position: absolute; inset-inline-start: 13px; top: 11px; color: var(--ink3); width: 20px; height: 20px; }\n.hact { display: flex; align-items: center; gap: 8px; margin-inline-start: auto; }\n.hbtn { position: relative; height: 44px; min-width: 44px; padding-inline: 12px; border: 1px solid var(--line); border-radius: 12px; background: #fff; display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-weight: 500; font-size: 14px; transition: background .15s, border-color .15s; }\n.hbtn:hover { background: var(--bg); }\n.hbtn.solid { background: var(--brand); color: #fff; border-color: var(--brand); }\n.hbtn.solid:hover { background: var(--brand-d); }\n.badge { position: absolute; top: -6px; inset-inline-end: -6px; min-width: 20px; height: 20px; border-radius: 10px; background: var(--accent); color: #2b1a00; font-size: 11px; font-weight: 700; display: grid; place-items: center; padding-inline: 5px; }\n.hbtn .lbl { display: none; }\n.hsearch-m { display: none; padding-bottom: 12px; }\n.cats { border-top: 1px solid var(--line); background: #fff; }\n.cats-in { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding-block: 8px; }\n.cats-in::-webkit-scrollbar { display: none; }\n.cat-link { flex: none; padding: 7px 14px; border-radius: 10px; font-size: 14px; font-weight: 500; color: var(--ink2); white-space: nowrap; }\n.cat-link:hover { background: var(--bg); color: var(--ink); }\n.cat-link[aria-current] { background: var(--brand-l); color: var(--brand-d); font-weight: 600; }\n\n/* البطل */\n.hero { margin-top: 18px; position: relative; border-radius: 22px; overflow: hidden; min-height: 280px; background: #0b3f3d; color: #fff; isolation: isolate; }\n.slide { position: absolute; inset: 0; display: flex; align-items: center; padding: 34px clamp(22px, 5vw, 64px); opacity: 0; transition: opacity .6s; pointer-events: none; }\n.slide.on { opacity: 1; pointer-events: auto; }\n.slide::before { content: ''; position: absolute; inset: 0; z-index: -1; background: var(--g); }\n.slide::after { content: ''; position: absolute; z-index: -1; width: 420px; height: 420px; border-radius: 50%; inset-inline-end: -120px; bottom: -180px; background: rgba(255,255,255,.07); }\n.slide .txt { max-width: 520px; display: grid; gap: 12px; justify-items: start; }\n.slide .tag { font-size: 12px; font-weight: 600; letter-spacing: .02em; background: rgba(255,255,255,.16); padding: 3px 12px; border-radius: 99px; }\n.slide h1 { font-size: clamp(24px, 3.4vw, 40px); font-weight: 700; }\n.slide p { color: rgba(255,255,255,.86); font-size: clamp(14px, 1.5vw, 17px); }\n.slide .btn { margin-top: 6px; }\n.dots { position: absolute; bottom: 14px; inset-inline: 0; display: flex; justify-content: center; gap: 7px; }\n.dots button { width: 8px; height: 8px; border-radius: 99px; border: 0; padding: 0; background: rgba(255,255,255,.4); transition: width .2s, background .2s; }\n.dots button[aria-current] { width: 24px; background: #fff; }\n.slide .deco { position: absolute; inset-inline-end: clamp(16px, 6vw, 90px); top: 50%; transform: translateY(-50%); display: none; gap: 12px; }\n.slide .deco span { width: 84px; height: 84px; border-radius: 22px; display: grid; place-items: center; font-weight: 700; font-size: 30px; box-shadow: 0 10px 30px rgba(0,0,0,.25); }\n.slide .deco span:nth-child(2) { transform: translateY(22px); }\n\n/* أزرار */\n.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 46px; padding-inline: 22px; border-radius: 12px; border: 1px solid transparent; background: var(--brand); color: #fff; font-weight: 600; font-size: 15px; transition: background .15s, transform .05s, box-shadow .15s; }\n.btn:hover { background: var(--brand-d); }\n.btn:active { transform: scale(.98); }\n.btn:disabled { opacity: .55; cursor: not-allowed; }\n.btn.light { background: #fff; color: var(--ink); }\n.btn.light:hover { background: #f1f5f9; }\n.btn.ghost { background: #fff; color: var(--ink); border-color: var(--line); }\n.btn.ghost:hover { background: var(--bg); }\n.btn.dark { background: var(--ink); }\n.btn.dark:hover { background: #1e293b; }\n.btn.block { width: 100%; }\n.btn.sm { height: 38px; padding-inline: 14px; font-size: 13.5px; border-radius: 10px; }\n.linkbtn { background: none; border: 0; color: var(--brand-d); font-weight: 600; padding: 6px; }\n\n/* مزايا */\n.features { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 18px; }\n.feat { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 14px 16px; display: flex; gap: 12px; align-items: center; }\n.feat .ico { width: 40px; height: 40px; padding: 9px; background: var(--brand-l); color: var(--brand-d); border-radius: 12px; }\n.feat b { display: block; font-size: 14px; font-weight: 600; }\n.feat span { color: var(--ink2); font-size: 12.5px; }\n\n/* أقسام */\n.section { margin-top: 34px; }\n.sec-head { display: flex; align-items: end; justify-content: space-between; gap: 12px; margin-bottom: 14px; }\n.sec-head h2 { font-size: 21px; font-weight: 700; }\n.sec-head p { color: var(--ink2); font-size: 13.5px; }\n.sort { height: 40px; border: 1px solid var(--line); border-radius: 10px; background: #fff; padding-inline: 10px; font-size: 14px; }\n.cat-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }\n.cat-tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 16px 12px; display: grid; justify-items: center; gap: 10px; font-weight: 600; font-size: 14px; transition: transform .15s, box-shadow .15s, border-color .15s; }\n.cat-tile:hover { transform: translateY(-2px); box-shadow: var(--shadow); border-color: #cfe5e3; }\n.cat-tile .ico { width: 52px; height: 52px; padding: 13px; border-radius: 16px; background: var(--brand-l); color: var(--brand-d); }\n\n/* المنتجات */\n.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 16px; }\n.card { background: var(--surface); border: 1px solid var(--line); border-radius: 18px; overflow: hidden; display: flex; flex-direction: column; transition: transform .18s, box-shadow .18s; }\n.card:hover { transform: translateY(-3px); box-shadow: var(--shadow); }\n.thumb { aspect-ratio: 16 / 10; display: grid; place-items: center; position: relative; background: linear-gradient(145deg, var(--c), color-mix(in srgb, var(--c) 55%, #000)); color: var(--ink-on, #fff); overflow: hidden; }\n.thumb::before { content: ''; position: absolute; width: 150px; height: 150px; border-radius: 50%; background: rgba(255,255,255,.14); inset-inline-start: -40px; top: -50px; }\n.thumb::after { content: ''; position: absolute; width: 110px; height: 110px; border-radius: 50%; background: rgba(0,0,0,.1); inset-inline-end: -30px; bottom: -40px; }\n.thumb .gl { position: relative; z-index: 1; font-size: 46px; font-weight: 700; letter-spacing: -.02em; direction: ltr; text-shadow: 0 4px 14px rgba(0,0,0,.18); }\n.thumb .cat-pill { position: absolute; z-index: 1; top: 10px; inset-inline-start: 10px; background: rgba(255,255,255,.92); color: var(--ink); font-size: 11.5px; font-weight: 600; padding: 2px 10px; border-radius: 99px; }\n.card .body { padding: 14px 16px 16px; display: grid; gap: 6px; flex: 1; align-content: start; }\n.card h3 { font-size: 16.5px; font-weight: 700; }\n.card .desc { color: var(--ink2); font-size: 13px; min-height: 40px; line-height: 1.55; }\n.card .foot { display: flex; align-items: end; justify-content: space-between; gap: 8px; margin-top: 8px; }\n.price { font-weight: 700; font-size: 19px; }\n.price small { display: block; font-weight: 400; font-size: 11.5px; color: var(--ink3); line-height: 1.2; }\n.soldout { color: var(--bad); font-weight: 600; font-size: 13px; }\n.empty { background: var(--surface); border: 1px dashed var(--line); border-radius: var(--r); padding: 44px 16px; text-align: center; color: var(--ink2); display: grid; gap: 12px; justify-items: center; }\n\n/* صفحة المنتج */\n.crumbs { display: flex; gap: 8px; align-items: center; color: var(--ink2); font-size: 13px; margin-top: 18px; flex-wrap: wrap; }\n.crumbs a:hover { color: var(--brand-d); }\n.pdp { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 26px; margin-top: 14px; align-items: start; }\n.pdp .thumb { border-radius: 22px; aspect-ratio: 4 / 3; }\n.pdp .thumb .gl { font-size: 84px; }\n.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 22px; display: grid; gap: 16px; }\n.pdp h1 { font-size: 28px; }\n.plans { display: grid; gap: 10px; }\n.plan { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 16px; border: 1.5px solid var(--line); border-radius: 13px; background: #fff; text-align: start; width: 100%; transition: border-color .15s, background .15s; }\n.plan:hover { border-color: #b7d8d5; }\n.plan[aria-checked=true] { border-color: var(--brand); background: var(--brand-l); }\n.plan .rd { width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--line); display: grid; place-items: center; flex: none; }\n.plan[aria-checked=true] .rd { border-color: var(--brand); }\n.plan[aria-checked=true] .rd::after { content: ''; width: 10px; height: 10px; border-radius: 50%; background: var(--brand); }\n.plan .nm { flex: 1; font-weight: 600; }\n.plan .pr { font-weight: 700; font-size: 17px; }\n.plan[disabled] { opacity: .5; cursor: not-allowed; }\n.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }\n.trust { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }\n.trust div { text-align: center; font-size: 12.5px; color: var(--ink2); background: var(--bg); border-radius: 12px; padding: 10px 6px; display: grid; justify-items: center; gap: 4px; }\n.trust .ico { color: var(--brand-d); }\n.note { color: var(--ink2); font-size: 13px; background: var(--bg); border-radius: 12px; padding: 10px 14px; }\n\n/* الدرج والنوافذ */\n#overlay { position: fixed; inset: 0; z-index: 60; background: rgba(15,23,42,.5); display: flex; animation: fade .18s; }\n#overlay[hidden] { display: none; }\n@keyframes fade { from { opacity: 0; } }\n.drawer { width: min(440px, 100%); background: #fff; height: 100%; display: flex; flex-direction: column; margin-inline-start: auto; animation: slide .22s ease-out; }\n@keyframes slide { from { transform: translateX(-40px); opacity: 0; } }\n.modal { margin: auto; width: min(460px, calc(100% - 24px)); max-height: calc(100% - 24px); overflow: auto; background: #fff; border-radius: 20px; padding: 24px; animation: pop .2s ease-out; position: relative; }\n@keyframes pop { from { transform: scale(.96) translateY(8px); opacity: 0; } }\n.mhead { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--line); }\n.mhead h2 { font-size: 18px; }\n.x { width: 38px; height: 38px; border: 0; background: var(--bg); border-radius: 10px; display: grid; place-items: center; }\n.modal .x { position: absolute; top: 14px; inset-inline-end: 14px; }\n.dbody { flex: 1; overflow: auto; padding: 16px 20px; display: grid; gap: 12px; align-content: start; }\n.dfoot { border-top: 1px solid var(--line); padding: 16px 20px calc(16px + env(safe-area-inset-bottom, 0px)); display: grid; gap: 10px; background: #fff; }\n.line { display: flex; gap: 12px; align-items: center; padding: 10px; border: 1px solid var(--line); border-radius: 14px; }\n.line .thumb { width: 56px; aspect-ratio: 1; border-radius: 12px; flex: none; }\n.line .thumb .gl { font-size: 22px; }\n.line .thumb::before, .line .thumb::after { display: none; }\n.line .grow { flex: 1; min-width: 0; }\n.line .grow b { display: block; }\n.line .grow span { color: var(--ink2); font-size: 13px; }\n.rm { border: 0; background: none; color: var(--ink3); padding: 8px; border-radius: 8px; }\n.rm:hover { color: var(--bad); background: var(--bad-bg); }\n.sum { display: flex; justify-content: space-between; align-items: center; }\n.sum.big { font-size: 18px; font-weight: 700; }\n.warnbox { background: var(--warn-bg); color: var(--warn); border-radius: 12px; padding: 10px 14px; font-size: 13.5px; }\n.okbox { background: var(--ok-bg); color: var(--ok); border-radius: 12px; padding: 10px 14px; font-size: 13.5px; }\n\n/* النماذج */\n.form { display: grid; gap: 14px; margin-top: 14px; }\n.field { display: grid; gap: 6px; font-weight: 500; font-size: 14px; }\n.field input { height: 48px; border: 1.5px solid var(--line); border-radius: 12px; padding-inline: 14px; outline: none; background: #fff; font-weight: 400; }\n.field input:focus { border-color: var(--brand); }\n.err { color: var(--bad); font-size: 13.5px; min-height: 0; }\n.err:empty { display: none; }\n.auth h2 { font-size: 22px; }\n.auth .sub { color: var(--ink2); margin-top: 4px; font-size: 14px; }\n.tabs { display: flex; gap: 6px; background: var(--bg); padding: 4px; border-radius: 12px; }\n.tabs button { flex: 1; height: 38px; border: 0; background: none; border-radius: 9px; font-weight: 600; color: var(--ink2); }\n.tabs button[aria-current] { background: #fff; color: var(--ink); box-shadow: 0 1px 3px rgba(15,23,42,.1); }\n\n/* الحساب */\n.acct { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 20px; margin-top: 20px; align-items: start; }\n.side { display: grid; gap: 6px; background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 12px; }\n.side .who { padding: 10px 12px 14px; border-bottom: 1px solid var(--line); margin-bottom: 6px; }\n.side .who b { display: block; }\n.side .who span { color: var(--ink2); font-size: 13px; }\n.side button { display: flex; align-items: center; gap: 10px; border: 0; background: none; height: 44px; padding-inline: 12px; border-radius: 11px; font-weight: 500; text-align: start; }\n.side button:hover { background: var(--bg); }\n.side button[aria-current] { background: var(--brand-l); color: var(--brand-d); font-weight: 600; }\n.wallet-card { background: linear-gradient(135deg, #0b4f4b, #0b7a75 60%, #14b8a6); color: #fff; border-radius: 20px; padding: 24px; display: grid; gap: 4px; position: relative; overflow: hidden; }\n.wallet-card::after { content: ''; position: absolute; width: 220px; height: 220px; border-radius: 50%; background: rgba(255,255,255,.08); inset-inline-end: -70px; top: -90px; }\n.wallet-card span { color: rgba(255,255,255,.8); font-size: 14px; }\n.wallet-card b { font-size: 38px; font-weight: 700; line-height: 1.2; direction: ltr; text-align: start; }\n.packs { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 10px; }\n.pack { height: 54px; border: 1.5px solid var(--line); border-radius: 13px; background: #fff; font-weight: 700; font-size: 17px; }\n.pack[aria-pressed=true] { border-color: var(--brand); background: var(--brand-l); color: var(--brand-d); }\n.rows { display: grid; gap: 8px; }\n.row { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 12px 14px; border: 1px solid var(--line); border-radius: 13px; background: #fff; text-align: start; width: 100%; }\nbutton.row:hover { background: var(--bg); }\n.row .t { font-weight: 600; }\n.row .m { color: var(--ink2); font-size: 12.5px; }\n.amt { font-weight: 700; direction: ltr; }\n.amt.in { color: var(--ok); }\n.pill { display: inline-block; padding: 2px 11px; border-radius: 99px; font-size: 12px; font-weight: 600; background: #eef1f5; color: var(--ink2); }\n.pill.ok { background: var(--ok-bg); color: var(--ok); }\n.pill.warn { background: var(--warn-bg); color: var(--warn); }\n.code { background: #0f172a; color: #e2e8f0; border-radius: 14px; padding: 14px; display: grid; gap: 10px; }\n.code pre { margin: 0; white-space: pre-wrap; word-break: break-all; direction: ltr; text-align: left; font: 500 14px/1.7 ui-monospace, Menlo, monospace; }\n.tabbar-m { display: none; }\n\n/* FAQ */\n.faq { display: grid; gap: 10px; }\n.faq details { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 0 18px; }\n.faq summary { cursor: pointer; font-weight: 600; padding: 15px 0; list-style: none; display: flex; justify-content: space-between; gap: 12px; }\n.faq summary::-webkit-details-marker { display: none; }\n.faq summary::after { content: '+'; font-size: 20px; color: var(--ink3); line-height: 1.3; }\n.faq details[open] summary::after { content: '−'; }\n.faq p { color: var(--ink2); padding-bottom: 16px; }\n.page { background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: clamp(20px, 4vw, 36px); margin-top: 18px; max-width: 820px; }\n.page h1 { font-size: 26px; margin-bottom: 14px; }\n.page h3 { margin: 18px 0 6px; font-size: 17px; }\n.page p, .page li { color: var(--ink2); }\n.page ul { padding-inline-start: 20px; }\n\n/* الفوتر */\n.footer { background: #0b1220; color: #b8c2d3; margin-top: 56px; padding-top: 38px; }\n.fgrid { display: grid; grid-template-columns: 1.6fr 1fr 1fr 1.2fr; gap: 28px; }\n.footer h4 { margin: 0 0 12px; color: #fff; font-size: 15px; }\n.footer p { font-size: 13.5px; line-height: 1.8; }\n.footer ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; font-size: 14px; }\n.footer a:hover, .footer button.fl:hover { color: #fff; }\n.footer button.fl { background: none; border: 0; padding: 0; color: inherit; font-size: 14px; text-align: start; }\n.footer .logo { color: #fff; margin-bottom: 12px; }\n.pay { direction: ltr; justify-content: flex-end; display: flex; gap: 8px; flex-wrap: wrap; }\n.pay span { height: 36px; min-width: 76px; padding-inline: 12px; border-radius: 8px; background: #fff; color: #1a1f71; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; letter-spacing: .01em; font-style: italic; direction: ltr; }\n.pay span + span { color: #1f2937; font-style: normal; font-weight: 600; }\n.fbar { border-top: 1px solid #1e293b; margin-top: 30px; padding-block: 16px calc(16px + env(safe-area-inset-bottom, 0px)); display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 13px; }\n.sec-note { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 13px; }\n.sec-note .ico { width: 18px; height: 18px; color: #5eead4; }\n\n#toast { position: fixed; z-index: 90; bottom: calc(24px + env(safe-area-inset-bottom, 0px)); inset-inline: 0; margin-inline: auto; width: fit-content; max-width: calc(100% - 32px); background: var(--ink); color: #fff; padding: 11px 20px; border-radius: 12px; font-size: 14px; opacity: 0; transform: translateY(12px); pointer-events: none; transition: .2s; box-shadow: 0 8px 28px rgba(0,0,0,.25); }\n#toast.show { opacity: 1; transform: none; }\n#toast.err { background: var(--bad); }\n\n@media (max-width: 960px) {\n  .features { grid-template-columns: repeat(2, 1fr); }\n  .fgrid { grid-template-columns: 1fr 1fr; }\n  .acct { grid-template-columns: 1fr; }\n  .side { grid-auto-flow: column; grid-auto-columns: 1fr; overflow-x: auto; }\n  .side .who { display: none; }\n  .side button { justify-content: center; white-space: nowrap; }\n}\n@media (min-width: 900px) {\n  .slide .deco { display: flex; }\n  .hbtn .lbl { display: inline; }\n}\n@media (max-width: 720px) {\n  .pdp { grid-template-columns: 1fr; }\n  .search { display: none; }\n  .hsearch-m { display: block; }\n  .hero { min-height: 250px; border-radius: 18px; }\n  .grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }\n  .card .body { padding: 10px 12px 12px; }\n  .card h3 { font-size: 14.5px; }\n  .card .desc { display: none; }\n  .thumb .gl { font-size: 34px; }\n  .card .foot .btn { padding-inline: 10px; }\n  .sec-head h2 { font-size: 18px; }\n  .actions { grid-template-columns: 1fr; }\n  .fgrid { grid-template-columns: 1fr; }\n  .logo span { display: none; }\n  .cat-tiles { grid-template-columns: repeat(3, 1fr); gap: 8px; }\n  .cat-tile { padding: 12px 6px; font-size: 12.5px; }\n  .cat-tile .ico { width: 44px; height: 44px; padding: 10px; }\n  .modal { padding: 20px; }\n}\n@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } html { scroll-behavior: auto; } }\n"},"/app.js":{"type":"text/javascript; charset=utf-8","body":"'use strict';\n/* ───────── إعدادات الموقع (عدّلها كما تشاء) ───────── */\nconst SITE = {\n  name: 'متجر الاشتراكات',\n  letter: 'م',\n  announce: 'ادفع بالبطاقة واشحن محفظتك بأمان — <b>تسليم سريع</b> لاشتراكاتك الرقمية',\n};\n\nconst $ = (s, r = document) => r.querySelector(s);\nconst app = $('#app');\nconst overlay = $('#overlay');\n\nconst store = {\n  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },\n  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },\n};\nlet token = store.get('tok');\nlet cart = (() => { try { return JSON.parse(store.get('cart') || '[]').filter(Number.isInteger); } catch { return []; } })();\n\nconst S = {\n  loaded: false, guest: true, products: [], categories: [], config: { topups: [], support: '' },\n  me: { balance: 0, name: '' }, orders: [], ledger: [],\n  q: '', sort: 'def', cat: 'all', topup: 10, busy: false, slide: 0,\n  acctTab: 'wallet', pdpPlan: null, modal: null, afterAuth: null, authMode: 'signup', authNote: '',\n};\n\n/* ───────── أدوات ───────── */\nconst esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[c]);\nconst usd = (c) => `$${c % 100 === 0 ? c / 100 : (c / 100).toFixed(2)}`;\nconst usd2 = (c) => `$${(c / 100).toFixed(2)}`;\nconst fmtDate = (t) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(t * 1000));\nconst lum = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };\nconst inkOn = (hex) => (lum(hex) > 0.62 ? '#14112b' : '#ffffff');\n\nconst ICONS = {\n  search: '<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20 20-3.5-3.5\"/>',\n  cart: '<path d=\"M3 4h2l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.2a1.5 1.5 0 0 0 1.5-1.1L20.5 8H6.2\"/><circle cx=\"9.5\" cy=\"20\" r=\"1.3\"/><circle cx=\"17\" cy=\"20\" r=\"1.3\"/>',\n  user: '<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4.5 20.5a7.5 7.5 0 0 1 15 0\"/>',\n  wallet: '<path d=\"M4 7.5A2.5 2.5 0 0 1 6.5 5H18a2 2 0 0 1 2 2v1.5\"/><path d=\"M4 7.5V17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 1 4 6.5\"/><circle cx=\"16\" cy=\"14\" r=\"1.2\"/>',\n  bag: '<path d=\"M6 3.5h12v17l-3-1.8-3 1.8-3-1.8-3 1.8z\"/><path d=\"M9.5 8.5h5M9.5 12h5\"/>',\n  x: '<path d=\"M6 6l12 12M18 6 6 18\"/>',\n  bolt: '<path d=\"M13 2.5 5 13.5h6l-1 8 8-11h-6z\"/>',\n  shield: '<path d=\"M12 3 4.5 6v5.5c0 4.5 3 7.7 7.5 9.5 4.5-1.8 7.5-5 7.5-9.5V6z\"/><path d=\"m9 12 2.2 2.2L15.5 10\"/>',\n  chat: '<path d=\"M4 5.5h16v10H9.5L5 19.5v-4H4z\"/>',\n  card: '<rect x=\"3\" y=\"5.5\" width=\"18\" height=\"13\" rx=\"2.5\"/><path d=\"M3 10h18M7 15h4\"/>',\n  trash: '<path d=\"M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13\"/>',\n  logout: '<path d=\"M14 4.5H6.5v15H14M10 12h10M17 9l3 3-3 3\"/>',\n  video: '<rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"3\"/><path d=\"m10.5 9.5 4 2.5-4 2.5z\"/>',\n  music: '<path d=\"M9 18V6l10-2v12\"/><circle cx=\"6.5\" cy=\"18\" r=\"2.5\"/><circle cx=\"16.5\" cy=\"16\" r=\"2.5\"/>',\n  ai: '<path d=\"M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z\"/><path d=\"M18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z\"/>',\n  games: '<rect x=\"3\" y=\"7.5\" width=\"18\" height=\"10\" rx=\"5\"/><path d=\"M8 10.5v4M6 12.5h4\"/><circle cx=\"15.5\" cy=\"11.5\" r=\".6\"/><circle cx=\"17.5\" cy=\"13.5\" r=\".6\"/>',\n  apps: '<rect x=\"4\" y=\"4\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"13\" y=\"4\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"4\" y=\"13\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"13\" y=\"13\" width=\"7\" height=\"7\" rx=\"2\"/>',\n  all: '<path d=\"M4 7h16M4 12h16M4 17h10\"/>',\n  lock: '<rect x=\"5\" y=\"11\" width=\"14\" height=\"9\" rx=\"2\"/><path d=\"M8 11V8a4 4 0 0 1 8 0v3\"/>',\n  check: '<path d=\"m5 12.5 4.5 4.5L19 7.5\"/>',\n};\nconst ico = (n, cls = '') => `<svg class=\"ico ${cls}\" viewBox=\"0 0 24 24\" aria-hidden=\"true\">${ICONS[n] || ''}</svg>`;\n\nlet toastTimer;\nfunction toast(msg, err = false) {\n  const el = $('#toast');\n  el.textContent = msg; el.className = `show${err ? ' err' : ''}`;\n  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.className = ''), 3400);\n}\n\nasync function api(path, body) {\n  const headers = { 'content-type': 'application/json' };\n  if (token) headers.authorization = `Bearer ${token}`;\n  let r;\n  try { r = await fetch(`/api${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined }); }\n  catch { throw Object.assign(new Error('تعذّر الاتصال. تحقق من الإنترنت وحاول مرة أخرى'), { status: 0 }); }\n  const j = await r.json().catch(() => ({}));\n  if (!r.ok) throw Object.assign(new Error(j.error || 'تعذّر إكمال الطلب. حاول مرة أخرى'), { status: r.status });\n  return j;\n}\n\nconst saveCart = () => store.set('cart', JSON.stringify(cart));\nconst GUEST = { me: { balance: 0, name: '' }, orders: [], ledger: [] };\n\nasync function refresh() {\n  try {\n    if (!token) Object.assign(S, await api('/catalog'), GUEST, { loaded: true, guest: true });\n    else Object.assign(S, await api('/state'), { loaded: true, guest: false });\n  } catch (e) {\n    if (token && e.status === 401) { token = ''; store.set('tok', ''); return refresh(); }\n    throw e;\n  }\n  cleanCart();\n  render();\n}\n\n/* ───────── بيانات مشتقة ───────── */\nconst product = (id) => S.products.find((p) => p.id === id);\nconst catName = (k) => S.categories.find((c) => c.key === k)?.name || '';\nconst minPrice = (p) => Math.min(...p.plans.filter((x) => x.available).map((x) => x.price));\nconst hasStock = (p) => p.plans.some((x) => x.available);\nfunction findPlan(planId) {\n  for (const p of S.products) { const pl = p.plans.find((x) => x.id === planId); if (pl) return { p, pl }; }\n  return null;\n}\nfunction cleanCart() {\n  const before = cart.length;\n  cart = cart.filter((id, i) => { const f = findPlan(id); return f && f.pl.available && cart.indexOf(id) === i; });\n  if (cart.length !== before) saveCart();\n}\nconst cartItems = () => cart.map(findPlan).filter(Boolean);\nconst cartTotal = () => cartItems().reduce((s, x) => s + x.pl.price, 0);\n\n/* ───────── المكوّنات ───────── */\nconst thumb = (p, cls = '') => `<div class=\"thumb ${cls}\" style=\"--c:${esc(p.color)};--ink-on:${inkOn(p.color)}\"><span class=\"gl\">${esc(p.glyph)}</span></div>`;\n\nfunction header() {\n  const q = esc(S.q);\n  const route = parseRoute();\n  const catLinks = [['all', 'الرئيسية', '#/'], ...S.categories.map((c) => [c.key, c.name, `#/cat/${c.key}`])];\n  const cur = route.name === 'home' ? 'all' : route.name === 'cat' ? route.arg : '';\n  return `\n  <div class=\"announce\">${SITE.announce}</div>\n  <header class=\"header\">\n    <div class=\"wrap\">\n      <div class=\"hrow\">\n        <a class=\"logo\" href=\"#/\" aria-label=\"${esc(SITE.name)}\"><i>${esc(SITE.letter)}</i><span>${esc(SITE.name)}</span></a>\n        <form class=\"search\" role=\"search\" data-form=\"search\">${ico('search')}<input type=\"search\" id=\"q\" value=\"${q}\" placeholder=\"ابحث عن خدمة أو اشتراك…\" autocomplete=\"off\" aria-label=\"بحث\"></form>\n        <div class=\"hact\">\n          ${S.guest\n            ? `<button class=\"hbtn\" data-act=\"login\" aria-label=\"تسجيل الدخول\">${ico('user')}<span class=\"lbl\">دخول</span></button>`\n            : `<a class=\"hbtn\" href=\"#/account/wallet\" aria-label=\"محفظتي\">${ico('wallet')}<span class=\"lbl\"><bdi>${usd2(S.me.balance)}</bdi></span></a>\n               <a class=\"hbtn\" href=\"#/account/orders\" aria-label=\"حسابي\">${ico('user')}<span class=\"lbl\">حسابي</span></a>`}\n          <button class=\"hbtn solid\" data-act=\"cart\" aria-label=\"السلة\">${ico('cart')}<span class=\"lbl\">السلة</span>${cart.length ? `<span class=\"badge\">${cart.length}</span>` : ''}</button>\n        </div>\n      </div>\n      <form class=\"hsearch-m\" role=\"search\" data-form=\"search\"><div class=\"search\" style=\"display:block;max-width:none;position:relative\">${ico('search')}<input type=\"search\" data-q value=\"${q}\" placeholder=\"ابحث عن خدمة أو اشتراك…\" aria-label=\"بحث\"></div></form>\n    </div>\n    <nav class=\"cats\" aria-label=\"الأقسام\"><div class=\"wrap cats-in\">\n      ${catLinks.map(([k, n, h]) => `<a class=\"cat-link\" href=\"${h}\" ${k === cur ? 'aria-current=\"page\"' : ''}>${esc(n)}</a>`).join('')}\n    </div></nav>\n  </header>`;\n}\n\nconst SLIDES = [\n  { g: 'linear-gradient(120deg,#073b3a,#0b7a75 70%,#12a79b)', tag: 'اشتراكات رقمية', h: 'كل اشتراكاتك المفضلة في مكان واحد', p: 'مشاهدة وموسيقى وذكاء اصطناعي وألعاب وتصميم. اختر باقتك وأكمل الشراء بخطوات بسيطة.', cta: 'تصفّح المنتجات', href: '#/all', deco: [['N', '#F0525C'], ['S', '#1DB954']] },\n  { g: 'linear-gradient(120deg,#1e1b4b,#4338ca 70%,#6366f1)', tag: 'محفظة إلكترونية', h: 'اشحن محفظتك بالبطاقة وادفع بسهولة', p: 'شحن آمن عبر البطاقات البنكية Visa وMastercard، ورصيدك جاهز لكل مشترياتك القادمة.', cta: 'اشحن الآن', href: '#/account/wallet', deco: [['$', '#f59e0b'], ['↑', '#14b8a6']] },\n  { g: 'linear-gradient(120deg,#7c2d12,#c2410c 70%,#f59e0b)', tag: 'سرعة وموثوقية', h: 'تسليم سريع ودعم يتابع طلبك', p: 'تصلك بيانات اشتراكك في صفحة طلباتك، ونحن جاهزون للمساعدة إن احتجت.', cta: 'الأسئلة الشائعة', href: '#/faq', deco: [['✓', '#15803d'], ['?', '#3E7BFA']] },\n];\n\nfunction hero() {\n  return `<section class=\"hero\" aria-roledescription=\"carousel\" aria-label=\"عروض\">\n    ${SLIDES.map((s, i) => `<div class=\"slide ${i === S.slide ? 'on' : ''}\" style=\"--g:${s.g}\" ${i === S.slide ? '' : 'aria-hidden=\"true\"'}>\n      <div class=\"txt\"><span class=\"tag\">${esc(s.tag)}</span><h1>${esc(s.h)}</h1><p>${esc(s.p)}</p><a class=\"btn light\" href=\"${s.href}\" ${i === S.slide ? '' : 'tabindex=\"-1\"'}>${esc(s.cta)}</a></div>\n      <div class=\"deco\" aria-hidden=\"true\">${s.deco.map(([g, c]) => `<span style=\"background:${c};color:${inkOn(c)}\">${g}</span>`).join('')}</div>\n    </div>`).join('')}\n    <div class=\"dots\">${SLIDES.map((_, i) => `<button data-act=\"slide\" data-i=\"${i}\" aria-label=\"شريحة ${i + 1}\" ${i === S.slide ? 'aria-current=\"true\"' : ''}></button>`).join('')}</div>\n  </section>`;\n}\n\nconst FEATS = [\n  ['bolt', 'تسليم سريع', 'تصلك بيانات الاشتراك في صفحة طلباتك'],\n  ['shield', 'دفع آمن', 'بطاقات Visa وMastercard عبر بوابة مشفّرة'],\n  ['wallet', 'محفظة إلكترونية', 'اشحن مرة واحدة واشترِ متى شئت'],\n  ['chat', 'دعم ومتابعة', 'نتابع معك طلبك إن واجهتك أي مشكلة'],\n];\nconst features = () => `<div class=\"features\">${FEATS.map(([i, t, d]) => `<div class=\"feat\">${ico(i)}<div><b>${t}</b><span>${d}</span></div></div>`).join('')}</div>`;\n\nfunction card(p) {\n  const ok = hasStock(p);\n  return `<article class=\"card\">\n    <a href=\"#/p/${p.id}\" aria-label=\"${esc(p.name)}\">${thumb(p)}</a>\n    <div class=\"body\">\n      <h3><a href=\"#/p/${p.id}\">${esc(p.name)}</a></h3>\n      <p class=\"desc\">${esc(p.desc)}</p>\n      <div class=\"foot\">\n        ${ok ? `<div class=\"price\"><small>يبدأ من</small><bdi>${usd(minPrice(p))}</bdi></div><a class=\"btn sm\" href=\"#/p/${p.id}\">عرض الباقات</a>`\n          : `<span class=\"soldout\">غير متوفر حاليًا</span><a class=\"btn sm ghost\" href=\"#/p/${p.id}\">التفاصيل</a>`}\n      </div>\n    </div></article>`;\n}\n\nfunction filtered(catKey) {\n  const q = S.q.trim().toLowerCase();\n  let list = S.products.filter((p) => (catKey === 'all' || p.cat === catKey) && (!q || p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q)));\n  if (S.sort === 'low') list = [...list].sort((a, b) => (hasStock(a) ? minPrice(a) : 1e9) - (hasStock(b) ? minPrice(b) : 1e9));\n  if (S.sort === 'high') list = [...list].sort((a, b) => (hasStock(b) ? minPrice(b) : -1) - (hasStock(a) ? minPrice(a) : -1));\n  return list;\n}\n\nfunction gridBlock(catKey, title) {\n  const list = filtered(catKey);\n  return `<section class=\"section\" id=\"products\">\n    <div class=\"sec-head\"><div><h2>${esc(title)}</h2><p>${list.length} ${list.length === 1 ? 'منتج' : 'منتجات'}</p></div>\n      <select class=\"sort\" data-sort aria-label=\"ترتيب\"><option value=\"def\" ${S.sort === 'def' ? 'selected' : ''}>الترتيب الافتراضي</option><option value=\"low\" ${S.sort === 'low' ? 'selected' : ''}>الأقل سعرًا</option><option value=\"high\" ${S.sort === 'high' ? 'selected' : ''}>الأعلى سعرًا</option></select></div>\n    <div id=\"grid\">${gridInner(list)}</div></section>`;\n}\nconst gridInner = (list) => (list.length ? `<div class=\"grid\">${list.map(card).join('')}</div>` : `<div class=\"empty\"><p>ما لقينا منتجًا مطابقًا${S.q ? ' لبحثك' : ''}.</p>${S.q ? '<button class=\"btn sm ghost\" data-act=\"clearq\">مسح البحث</button>' : ''}</div>`);\n\nconst FAQ = [\n  ['كيف أشتري؟', 'تصفّح المنتجات، اختر الباقة، أضفها إلى السلة ثم أكمل الشراء. يُطلب منك إنشاء حساب عند الشراء فقط، ويُخصم المبلغ من رصيد محفظتك.'],\n  ['كيف أشحن محفظتي؟', 'من حسابك افتح «المحفظة»، اختر المبلغ ثم اضغط «اشحن». تُحوَّل إلى صفحة دفع آمنة، وبعد نجاح الدفع يُضاف الرصيد لمحفظتك تلقائيًا.'],\n  ['ما وسائل الدفع؟', 'حاليًا نقبل البطاقات البنكية Visa وMastercard لشحن المحفظة.'],\n  ['متى أستلم اشتراكي؟', 'بعد تأكيد الطلب تظهر بيانات الاشتراك في صفحة «طلباتي». بعض الطلبات تُجهَّز يدويًا فتبقى «قيد التجهيز» حتى يسلّمها فريق المتجر.'],\n  ['ماذا لو واجهت مشكلة في الاشتراك؟', 'تواصل معنا عبر الدعم مع رقم طلبك وسنتابع المشكلة معك. وفي حال تعذّر التسليم نعيد المبلغ إلى محفظتك.'],\n  ['هل أستطيع استعادة كلمة المرور؟', 'لا تتوفر الاستعادة التلقائية حاليًا، فاحفظ كلمة مرورك في مكان آمن. إن نسيتها تواصل مع الدعم.'],\n];\nconst faqBlock = () => `<section class=\"section\" id=\"faq\"><div class=\"sec-head\"><div><h2>الأسئلة الشائعة</h2></div></div>\n  <div class=\"faq\">${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></section>`;\n\nfunction footer() {\n  const sup = S.config.support ? `<li><a href=\"https://t.me/${esc(S.config.support)}\" target=\"_blank\" rel=\"noopener\">تواصل مع الدعم</a></li>` : '';\n  return `<footer class=\"footer\"><div class=\"wrap\">\n    <div class=\"fgrid\">\n      <div><a class=\"logo\" href=\"#/\"><i>${esc(SITE.letter)}</i><span>${esc(SITE.name)}</span></a>\n        <p>متجر للاشتراكات الرقمية. نوفّر لك أشهر الخدمات بأسعار واضحة، مع محفظة إلكترونية ودفع آمن.</p>\n        <div class=\"sec-note\">${ico('lock')}<span>بياناتك محمية، ولا نحفظ بيانات بطاقتك.</span></div></div>\n      <div><h4>روابط سريعة</h4><ul><li><a href=\"#/\">الرئيسية</a></li><li><a href=\"#/all\">كل المنتجات</a></li><li><a href=\"#/account/orders\">طلباتي</a></li><li><a href=\"#/account/wallet\">المحفظة</a></li></ul></div>\n      <div><h4>المساعدة</h4><ul><li><a href=\"#/faq\">الأسئلة الشائعة</a></li><li><a href=\"#/page/terms\">الشروط والأحكام</a></li><li><a href=\"#/page/refund\">سياسة الاسترجاع</a></li><li><a href=\"#/page/privacy\">سياسة الخصوصية</a></li>${sup}</ul></div>\n      <div><h4>بوابة الدفع</h4><div class=\"pay\" aria-label=\"وسائل الدفع المقبولة\"><span>VISA</span><span>Mastercard</span></div></div>\n    </div>\n    <div class=\"fbar\"><span>© ${new Date().getFullYear()} ${esc(SITE.name)}. جميع الحقوق محفوظة.</span><span>الأسعار بالدولار الأمريكي (USD)</span></div>\n  </div></footer>`;\n}\n\n/* ───────── الصفحات ───────── */\nfunction homePage() {\n  const tiles = S.categories.map((c) => `<a class=\"cat-tile\" href=\"#/cat/${c.key}\">${ico(ICONS[c.key] ? c.key : 'apps')}<span>${esc(c.name)}</span></a>`).join('');\n  if (S.q.trim()) return `<div class=\"wrap\">${gridBlock('all', `نتائج البحث عن «${S.q.trim()}»`)}</div>`;\n  return `<div class=\"wrap\">${hero()}${features()}\n    <section class=\"section\"><div class=\"sec-head\"><div><h2>تسوّق حسب القسم</h2></div></div><div class=\"cat-tiles\">${tiles}</div></section>\n    ${gridBlock('all', 'جميع المنتجات')}\n    ${faqBlock()}</div>`;\n}\n\nfunction catPage(key) {\n  const c = S.categories.find((x) => x.key === key);\n  if (!c) return notFound();\n  return `<div class=\"wrap\"><div class=\"crumbs\"><a href=\"#/\">الرئيسية</a><span>›</span><span>${esc(c.name)}</span></div>${gridBlock(key, c.name)}</div>`;\n}\n\nfunction pdpPage(id) {\n  const p = product(id);\n  if (!p) return notFound();\n  const avail = p.plans.filter((x) => x.available);\n  if (!avail.find((x) => x.id === S.pdpPlan)) S.pdpPlan = avail[0]?.id ?? null;\n  const sel = p.plans.find((x) => x.id === S.pdpPlan);\n  const related = S.products.filter((x) => x.cat === p.cat && x.id !== p.id).slice(0, 4);\n  return `<div class=\"wrap\">\n    <div class=\"crumbs\"><a href=\"#/\">الرئيسية</a><span>›</span><a href=\"#/cat/${esc(p.cat)}\">${esc(catName(p.cat))}</a><span>›</span><span dir=\"ltr\">${esc(p.name)}</span></div>\n    <div class=\"pdp\">\n      ${thumb(p)}\n      <div class=\"panel\">\n        <div><span class=\"pill\">${esc(catName(p.cat))}</span></div>\n        <h1>${esc(p.name)}</h1>\n        <p style=\"color:var(--ink2)\">${esc(p.desc)}</p>\n        ${avail.length ? `<div><b>اختر الباقة</b><div class=\"plans\" role=\"radiogroup\" aria-label=\"الباقات\" style=\"margin-top:10px\">\n          ${p.plans.map((pl) => `<button class=\"plan\" role=\"radio\" aria-checked=\"${pl.id === S.pdpPlan}\" data-act=\"plan\" data-id=\"${pl.id}\" ${pl.available ? '' : 'disabled'}><span class=\"rd\"></span><span class=\"nm\">${esc(pl.label)}${pl.available ? '' : ' (غير متوفرة)'}</span><span class=\"pr\"><bdi>${usd(pl.price)}</bdi></span></button>`).join('')}</div></div>\n          <div class=\"actions\"><button class=\"btn\" data-act=\"add\" data-id=\"${sel.id}\">${ico('cart')} أضف إلى السلة</button><button class=\"btn dark\" data-act=\"buynow\" data-id=\"${sel.id}\">اشترِ الآن</button></div>`\n          : '<div class=\"warnbox\">هذه الخدمة غير متوفرة حاليًا. جرّب لاحقًا أو تصفّح منتجات أخرى.</div>'}\n        <div class=\"trust\"><div>${ico('shield')}دفع آمن</div><div>${ico('bolt')}تسليم سريع</div><div>${ico('chat')}دعم ومتابعة</div></div>\n        <p class=\"note\">يُخصم المبلغ من رصيد محفظتك. تظهر بيانات الاشتراك في «طلباتي»، وقد يُجهَّز بعضها يدويًا خلال وقت قصير.</p>\n      </div>\n    </div>\n    ${related.length ? `<section class=\"section\"><div class=\"sec-head\"><div><h2>منتجات مشابهة</h2></div></div><div class=\"grid\">${related.map(card).join('')}</div></section>` : ''}\n  </div>`;\n}\n\nconst PAGES = {\n  terms: ['الشروط والأحكام', `<p>باستخدامك هذا المتجر فإنك توافق على الشروط التالية.</p><h3>الطلبات</h3><p>الأسعار المعروضة بالدولار الأمريكي وقد تتغير دون إشعار مسبق، ويُعتمد السعر وقت إتمام الطلب.</p><h3>التسليم</h3><p>تُسلَّم بيانات الاشتراك في صفحة «طلباتي». الطلبات اليدوية تبقى «قيد التجهيز» حتى يسلّمها فريق المتجر.</p><h3>حسابك</h3><ul><li>أنت مسؤول عن سرّية بريدك وكلمة مرورك.</li><li>لا يجوز إعادة بيع بيانات الاشتراكات إلا بإذن مسبق.</li><li>يحق لنا إيقاف أي حساب يُساء استخدامه.</li></ul>`],\n  refund: ['سياسة الاسترجاع', `<p>لأن المنتجات رقمية وتُسلَّم فورًا، فإن الاسترجاع محدود بالحالات التالية:</p><ul><li>تعذّر التسليم أو عدم توفر الاشتراك: يُعاد المبلغ كاملًا إلى محفظتك.</li><li>اشتراك لا يعمل عند الاستلام: تواصل مع الدعم برقم الطلب لنعالج المشكلة أو نعيد المبلغ.</li><li>بعد استخدام الاشتراك بنجاح لا يمكن استرجاعه.</li></ul><p>يُعاد المبلغ دائمًا إلى رصيد المحفظة.</p>`],\n  privacy: ['سياسة الخصوصية', `<p>نحترم خصوصيتك ونجمع أقل قدر من البيانات.</p><ul><li>نحفظ بريدك واسمك وسجل طلباتك ورصيد محفظتك لتشغيل حسابك.</li><li>كلمات المرور تُخزَّن مشفّرة ولا يمكننا قراءتها.</li><li>الدفع بالبطاقة يتم عبر بوابة دفع خارجية، ولا نخزّن بيانات بطاقتك.</li><li>لا نبيع بياناتك لأي طرف.</li></ul>`],\n};\nfunction staticPage(key) {\n  const pg = PAGES[key];\n  if (!pg) return notFound();\n  return `<div class=\"wrap\"><div class=\"page\"><h1>${pg[0]}</h1>${pg[1]}</div></div>`;\n}\nconst notFound = () => `<div class=\"wrap\"><div class=\"empty\" style=\"margin-top:24px\"><h2>الصفحة غير موجودة</h2><a class=\"btn sm\" href=\"#/\">العودة للرئيسية</a></div></div>`;\n\n/* ───────── الحساب ───────── */\nconst STATUS = { delivered: ['تم التسليم', 'ok'], pending: ['قيد التجهيز', 'warn'], paid: ['قيد التجهيز', 'warn'], awaiting: ['بانتظار الدفع', ''], refunded: ['مسترد', ''] };\nconst pill = (s) => { const [t, c] = STATUS[s] || [s, '']; return `<span class=\"pill ${c}\">${t}</span>`; };\n\nfunction walletPane() {\n  const packs = S.config.topups || [];\n  return `<div class=\"wallet-card\"><span>رصيد محفظتك</span><b>${usd2(S.me.balance)}</b></div>\n    <div class=\"panel\" style=\"margin-top:16px\">\n      <div><b>اشحن محفظتك</b><p style=\"color:var(--ink2);font-size:13.5px\">اختر المبلغ ثم ادفع بالبطاقة (Visa / Mastercard).</p></div>\n      ${S.config.web ? `<div class=\"packs\">${packs.map((k) => `<button class=\"pack\" data-act=\"pack\" data-usd=\"${k.usd}\" aria-pressed=\"${k.usd === S.topup}\">$${k.usd}</button>`).join('')}</div>\n      <button class=\"btn block\" data-act=\"topup\" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class=\"spin\"></span>' : `${ico('card')} اشحن $${S.topup} بالبطاقة`}</button>\n      <p class=\"note\">${ico('lock', '')} تتم عملية الدفع في صفحة آمنة خارج المتجر، ولا نحفظ بيانات بطاقتك.</p>`\n      : '<div class=\"warnbox\">الشحن غير مفعّل حاليًا.</div>'}\n    </div>\n    <h3 style=\"margin:22px 0 10px\">آخر العمليات</h3>\n    ${S.ledger.length ? `<div class=\"rows\">${S.ledger.map((l) => `<div class=\"row\"><div><div class=\"t\">${esc(l.note)}</div><div class=\"m\">${fmtDate(l.created)}</div></div><div class=\"amt ${l.delta > 0 ? 'in' : ''}\">${l.delta > 0 ? '+' : '−'}${usd2(Math.abs(l.delta))}</div></div>`).join('')}</div>` : '<div class=\"empty\"><p>لا توجد عمليات بعد.</p></div>'}`;\n}\n\nfunction ordersPane() {\n  if (!S.orders.length) return `<div class=\"empty\"><p>لم تطلب شيئًا بعد.</p><a class=\"btn sm\" href=\"#/all\">ابدأ التسوّق</a></div>`;\n  return `<div class=\"rows\">${S.orders.map((o) => `<button class=\"row\" data-act=\"order\" data-id=\"${o.id}\"><div><div class=\"t\" dir=\"ltr\" style=\"text-align:start\">${esc(o.product)} · ${esc(o.plan)}</div><div class=\"m\">طلب #${o.id} · ${fmtDate(o.created)}</div></div><div style=\"text-align:end\">${pill(o.status)}<div class=\"amt\" style=\"font-size:14px;margin-top:2px\">${usd2(o.price)}</div></div></button>`).join('')}</div>`;\n}\n\nfunction accountPage(tab) {\n  if (S.guest) { if (!S.modal && !S.prompted) { S.prompted = true; setTimeout(() => openAuth({ note: 'سجّل الدخول لتفتح حسابك.', mode: 'login' }), 0); } return `<div class=\"wrap\"><div class=\"empty\" style=\"margin-top:24px\"><p>سجّل الدخول لعرض حسابك.</p><button class=\"btn sm\" data-act=\"login\">تسجيل الدخول</button></div></div>`; }\n  tab = tab === 'orders' ? 'orders' : 'wallet';\n  return `<div class=\"wrap\"><div class=\"acct\">\n    <aside class=\"side\"><div class=\"who\"><b>${esc(S.me.name || 'حسابي')}</b><span>رصيدك: <bdi>${usd2(S.me.balance)}</bdi></span></div>\n      <button data-go=\"#/account/wallet\" ${tab === 'wallet' ? 'aria-current=\"page\"' : ''}>${ico('wallet')}المحفظة</button>\n      <button data-go=\"#/account/orders\" ${tab === 'orders' ? 'aria-current=\"page\"' : ''}>${ico('bag')}طلباتي</button>\n      <button data-act=\"logout\">${ico('logout')}تسجيل الخروج</button></aside>\n    <section>${tab === 'wallet' ? walletPane() : `<h2 style=\"margin-bottom:12px\">طلباتي</h2>${ordersPane()}`}</section>\n  </div></div>`;\n}\n\n/* ───────── التوجيه والعرض ───────── */\nfunction parseRoute() {\n  const h = (location.hash || '#/').replace(/^#\\/?/, '');\n  const [a, b] = h.split('/');\n  if (!a) return { name: 'home' };\n  if (a === 'all') return { name: 'all' };\n  if (a === 'cat') return { name: 'cat', arg: b };\n  if (a === 'p') return { name: 'pdp', arg: Number(b) };\n  if (a === 'account') return { name: 'account', arg: b };\n  if (a === 'page') return { name: 'page', arg: b };\n  if (a === 'faq') return { name: 'faq' };\n  return { name: 'nf' };\n}\n\nfunction render() {\n  if (!S.loaded) { app.innerHTML = '<div class=\"boot\"><span class=\"spin\"></span></div>'; return; }\n  const r = parseRoute();\n  let main;\n  switch (r.name) {\n    case 'home': main = homePage(); break;\n    case 'all': main = `<div class=\"wrap\">${gridBlock('all', 'جميع المنتجات')}</div>`; break;\n    case 'cat': main = catPage(r.arg); break;\n    case 'pdp': main = pdpPage(r.arg); break;\n    case 'account': main = accountPage(r.arg); break;\n    case 'page': main = staticPage(r.arg); break;\n    case 'faq': main = `<div class=\"wrap\">${faqBlock()}</div>`; break;\n    default: main = notFound();\n  }\n  const keepQ = document.activeElement && document.activeElement.matches?.('input[type=search]');\n  app.innerHTML = `${header()}<main id=\"main\">${main}</main>${footer()}`;\n  if (keepQ) { const el = [...document.querySelectorAll('.header input[type=search]')].find((i) => i.offsetParent !== null); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }\n  if (S.modal) renderModal();\n}\n\nwindow.addEventListener('hashchange', () => { S.prompted = false; closeOverlay(); render(); window.scrollTo(0, 0); });\n\n/* ───────── النوافذ ───────── */\nfunction showOverlay(html, cls) {\n  overlay.hidden = false;\n  overlay.innerHTML = html;\n  overlay.dataset.kind = cls;\n  document.body.style.overflow = 'hidden';\n}\nfunction closeOverlay() { overlay.hidden = true; overlay.innerHTML = ''; S.modal = null; document.body.style.overflow = ''; }\nfunction renderModal() {\n  const m = S.modal;\n  if (!m) return;\n  if (m.type === 'cart') showOverlay(cartHtml(), 'cart');\n  else if (m.type === 'auth') showOverlay(authHtml(), 'auth');\n  else if (m.type === 'order') showOverlay(orderHtml(m.id), 'order');\n  else if (m.type === 'done') showOverlay(doneHtml(m), 'done');\n}\nfunction openModal(m) { S.modal = m; renderModal(); }\n\nfunction cartHtml() {\n  const items = cartItems();\n  const total = cartTotal();\n  const short = total - S.me.balance;\n  return `<aside class=\"drawer\" role=\"dialog\" aria-modal=\"true\" aria-label=\"السلة\">\n    <div class=\"mhead\"><h2>السلة (${items.length})</h2><button class=\"x\" data-act=\"close\" aria-label=\"إغلاق\">${ico('x')}</button></div>\n    <div class=\"dbody\">${items.length ? items.map(({ p, pl }) => `<div class=\"line\">${thumb(p)}<div class=\"grow\"><b>${esc(p.name)}</b><span>${esc(pl.label)}</span></div><b><bdi>${usd(pl.price)}</bdi></b><button class=\"rm\" data-act=\"rm\" data-id=\"${pl.id}\" aria-label=\"حذف\">${ico('trash')}</button></div>`).join('')\n      : `<div class=\"empty\"><p>سلتك فارغة.</p><button class=\"btn sm\" data-act=\"close\">تصفّح المنتجات</button></div>`}</div>\n    ${items.length ? `<div class=\"dfoot\">\n      <div class=\"sum\"><span>المجموع</span><b class=\"big\"><bdi>${usd2(total)}</bdi></b></div>\n      ${S.guest ? '<div class=\"note\">سجّل دخولك أو أنشئ حسابًا عند الشراء. لن تخسر سلتك.</div>'\n        : short > 0 ? `<div class=\"warnbox\">رصيدك <bdi>${usd2(S.me.balance)}</bdi> لا يكفي. تحتاج <bdi>${usd2(short)}</bdi> إضافية.</div>`\n        : `<div class=\"okbox\">سيُخصم المبلغ من رصيدك (<bdi>${usd2(S.me.balance)}</bdi>).</div>`}\n      <button class=\"btn block\" data-act=\"checkout\" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class=\"spin\"></span>' : S.guest ? 'متابعة الشراء' : short > 0 ? 'اشحن المحفظة' : 'إتمام الشراء'}</button>\n    </div>` : ''}\n  </aside>`;\n}\n\nfunction authHtml() {\n  const su = S.authMode === 'signup';\n  return `<div class=\"modal auth\" role=\"dialog\" aria-modal=\"true\" aria-label=\"الحساب\">\n    <button class=\"x\" data-act=\"close\" aria-label=\"إغلاق\">${ico('x')}</button>\n    <h2>${su ? 'أنشئ حسابك' : 'أهلًا بعودتك'}</h2>\n    <p class=\"sub\">${esc(S.authNote) || (su ? 'حساب واحد لمحفظتك وطلباتك.' : 'سجّل الدخول لمتابعة محفظتك وطلباتك.')}</p>\n    <div class=\"tabs\" style=\"margin-top:14px\"><button data-act=\"authmode\" data-m=\"signup\" ${su ? 'aria-current=\"true\"' : ''}>حساب جديد</button><button data-act=\"authmode\" data-m=\"login\" ${su ? '' : 'aria-current=\"true\"'}>تسجيل الدخول</button></div>\n    <form id=\"authform\" class=\"form\" novalidate>\n      ${su ? '<label class=\"field\"><span>الاسم</span><input name=\"name\" autocomplete=\"name\" maxlength=\"40\"></label>' : ''}\n      <label class=\"field\"><span>البريد الإلكتروني</span><input name=\"email\" type=\"email\" inputmode=\"email\" autocomplete=\"email\" dir=\"ltr\" required></label>\n      <label class=\"field\"><span>كلمة المرور</span><input name=\"password\" type=\"password\" autocomplete=\"${su ? 'new-password' : 'current-password'}\" dir=\"ltr\" required minlength=\"8\"></label>\n      ${su ? '<p class=\"note\">8 أحرف على الأقل. لا نستطيع استعادة كلمة المرور تلقائيًا، فاحفظها في مكان آمن.</p>' : ''}\n      <div id=\"autherr\" class=\"err\" role=\"alert\"></div>\n      <button class=\"btn block\" type=\"submit\">${su ? 'إنشاء الحساب' : 'تسجيل الدخول'}</button>\n    </form></div>`;\n}\nfunction openAuth({ note = '', mode = 'signup', after = null } = {}) {\n  S.authNote = note; S.authMode = mode; S.afterAuth = after;\n  openModal({ type: 'auth' });\n  setTimeout(() => $('#authform input')?.focus(), 50);\n}\n\nfunction orderHtml(id) {\n  const o = S.orders.find((x) => x.id === id);\n  if (!o) return '';\n  return `<div class=\"modal\" role=\"dialog\" aria-modal=\"true\" aria-label=\"تفاصيل الطلب\">\n    <button class=\"x\" data-act=\"close\" aria-label=\"إغلاق\">${ico('x')}</button>\n    <h2 style=\"font-size:20px;margin-bottom:4px\">طلب #${o.id}</h2>\n    <p style=\"color:var(--ink2)\" dir=\"ltr\">${esc(o.product)} · ${esc(o.plan)}</p>\n    <div style=\"display:flex;gap:10px;align-items:center;margin:12px 0\">${pill(o.status)}<span class=\"amt\">${usd2(o.price)}</span><span style=\"color:var(--ink3);font-size:13px\">${fmtDate(o.created)}</span></div>\n    ${o.status === 'delivered' && o.delivery ? `<p style=\"margin-bottom:8px\"><b>بيانات اشتراكك</b></p><div class=\"code\"><pre id=\"code\">${esc(o.delivery)}</pre><button class=\"btn light sm\" data-act=\"copy\">نسخ</button></div>`\n      : o.status === 'refunded' ? '<div class=\"note\">تم استرداد المبلغ إلى محفظتك.</div>'\n      : '<div class=\"warnbox\">طلبك قيد التجهيز. ستظهر بيانات الاشتراك هنا فور تسليمه.</div>'}\n  </div>`;\n}\n\nfunction doneHtml(m) {\n  return `<div class=\"modal\" role=\"dialog\" aria-modal=\"true\" style=\"text-align:center\">\n    <button class=\"x\" data-act=\"close\" aria-label=\"إغلاق\">${ico('x')}</button>\n    <div style=\"width:64px;height:64px;border-radius:50%;background:var(--ok-bg);color:var(--ok);display:grid;place-items:center;margin:6px auto 12px\">${ico('check', '')}</div>\n    <h2 style=\"font-size:21px\">تم استلام طلبك</h2>\n    <p style=\"color:var(--ink2);margin:6px 0 16px\">${m.fail ? esc(m.fail) : (m.pending ? 'بعض الطلبات قيد التجهيز وستظهر بياناتها في «طلباتي» فور تسليمها.' : 'بيانات اشتراكك جاهزة في «طلباتي».')}</p>\n    <a class=\"btn block\" href=\"#/account/orders\" data-act=\"close\">عرض طلباتي</a></div>`;\n}\n\n/* ───────── الإجراءات ───────── */\nfunction addToCart(id, silent) {\n  if (!cart.includes(id)) { cart.push(id); saveCart(); }\n  if (!silent) toast('أُضيف إلى السلة');\n  render();\n}\n\nasync function checkout() {\n  if (S.busy) return;\n  const items = cartItems();\n  if (!items.length) return;\n  if (S.guest) { closeOverlay(); openAuth({ note: 'أنشئ حسابك أو سجّل الدخول لتكمل الشراء. سلتك محفوظة.', mode: 'signup', after: 'checkout' }); return; }\n  const total = cartTotal();\n  if (S.me.balance < total) {\n    const need = total - S.me.balance;\n    const packs = (S.config.topups || []).map((k) => k.usd);\n    S.topup = packs.find((u) => u * 100 >= need) || Math.max(...packs, 10);\n    closeOverlay(); if (location.hash === '#/account/wallet') render(); else location.hash = '#/account/wallet';\n    toast(`اشحن ${usd2(need)} على الأقل لإتمام الطلب`);\n    return;\n  }\n  S.busy = true; renderModal();\n  const done = []; let failMsg = '';\n  for (const { pl } of items) {\n    try { await api('/buy', { plan_id: pl.id, method: 'wallet' }); done.push(pl.id); }\n    catch (e) { failMsg = e.message; if (e.status === 401) { token = ''; store.set('tok', ''); } break; }\n  }\n  cart = cart.filter((id) => !done.includes(id)); saveCart();\n  S.busy = false;\n  try { await refresh(); } catch {}\n  if (!done.length) { toast(failMsg || 'تعذّر إتمام الطلب', true); openModal({ type: 'cart' }); return; }\n  const pending = S.orders.slice(0, done.length).some((o) => o.status !== 'delivered');\n  openModal({ type: 'done', pending, fail: failMsg ? `تم تنفيذ ${done.length} من ${items.length}. ${failMsg}` : '' });\n}\n\nasync function doTopup() {\n  if (S.busy) return;\n  S.busy = true; render();\n  try { const r = await api('/web/topup', { usd: S.topup }); location.href = r.url; }\n  catch (e) { toast(e.message, true); S.busy = false; render(); }\n}\n\nasync function handleReturn() {\n  const ref = new URLSearchParams(location.search).get('topup');\n  if (!ref) return;\n  if (S.guest) { openAuth({ note: 'سجّل الدخول لنؤكد شحنتك.', mode: 'login' }); return; }\n  location.hash = '#/account/wallet';\n  try {\n    const r = await api('/web/topup/check', { ref });\n    history.replaceState(null, '', location.pathname + '#/account/wallet');\n    if (r.status === 'paid') toast(`تمت إضافة $${r.cents / 100} إلى محفظتك`);\n    else toast('لم نستلم الدفع بعد. إن كنت دفعت فسيظهر الرصيد خلال دقائق');\n    await refresh();\n  } catch (e) { toast(e.message, true); }\n}\n\nfunction logout() {\n  api('/web/logout', {}).catch(() => {});\n  token = ''; store.set('tok', ''); Object.assign(S, GUEST, { guest: true });\n  closeOverlay(); location.hash = '#/'; render(); toast('تم تسجيل الخروج');\n}\n\n/* ───────── الأحداث ───────── */\ndocument.addEventListener('click', async (e) => {\n  const go = e.target.closest('[data-go]');\n  if (go) { location.hash = go.dataset.go; return; }\n  if (e.target === overlay) { closeOverlay(); return; }\n  const el = e.target.closest('[data-act]');\n  if (!el) return;\n  const d = el.dataset;\n  switch (d.act) {\n    case 'cart': openModal({ type: 'cart' }); break;\n    case 'close': closeOverlay(); break;\n    case 'login': openAuth({ mode: 'login' }); break;\n    case 'authmode': S.authMode = d.m; renderModal(); setTimeout(() => $('#authform input')?.focus(), 30); break;\n    case 'slide': S.slide = Number(d.i); updateSlides(); restartSlides(); break;\n    case 'plan': S.pdpPlan = Number(d.id); render(); break;\n    case 'add': addToCart(Number(d.id)); break;\n    case 'buynow': addToCart(Number(d.id), true); openModal({ type: 'cart' }); break;\n    case 'rm': cart = cart.filter((x) => x !== Number(d.id)); saveCart(); render(); break;\n    case 'checkout': checkout(); break;\n    case 'pack': S.topup = Number(d.usd); render(); break;\n    case 'topup': doTopup(); break;\n    case 'order': openModal({ type: 'order', id: Number(d.id) }); break;\n    case 'logout': logout(); break;\n    case 'clearq': S.q = ''; render(); break;\n    case 'copy': {\n      const text = $('#code')?.textContent || '';\n      (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast('تم النسخ')).catch(() => {\n        const r = document.createRange(); r.selectNodeContents($('#code')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('حدّد النص وانسخه');\n      });\n      break;\n    }\n  }\n});\n\ndocument.addEventListener('submit', async (e) => {\n  if (e.target.dataset.form === 'search') { e.preventDefault(); if (parseRoute().name !== 'home') location.hash = '#/'; return; }\n  if (e.target.id !== 'authform') return;\n  e.preventDefault();\n  const f = new FormData(e.target);\n  const btn = e.target.querySelector('button[type=submit]');\n  const err = $('#autherr');\n  btn.disabled = true; err.textContent = '';\n  try {\n    const r = await api(S.authMode === 'signup' ? '/web/signup' : '/web/login', { email: f.get('email'), password: f.get('password'), name: f.get('name') || '' });\n    token = r.token; store.set('tok', token);\n    const after = S.afterAuth; S.afterAuth = null; S.authNote = '';\n    closeOverlay(); await refresh();\n    toast('أهلًا بك');\n    if (after === 'checkout' && cart.length) openModal({ type: 'cart' });\n    handleReturn();\n  } catch (e2) { err.textContent = e2.message; btn.disabled = false; }\n});\n\ndocument.addEventListener('input', (e) => {\n  if (e.target.matches('#q, [data-q]')) {\n    S.q = e.target.value;\n    if (parseRoute().name !== 'home' && parseRoute().name !== 'all') { location.hash = '#/'; return; }\n    render();\n  }\n});\ndocument.addEventListener('change', (e) => { if (e.target.matches('[data-sort]')) { S.sort = e.target.value; render(); } });\ndocument.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeOverlay(); });\n\n/* ───────── الشرائح ───────── */\nfunction updateSlides() {\n  document.querySelectorAll('.slide').forEach((s, i) => { s.classList.toggle('on', i === S.slide); s.setAttribute('aria-hidden', i === S.slide ? 'false' : 'true'); s.querySelector('a')?.setAttribute('tabindex', i === S.slide ? '0' : '-1'); });\n  document.querySelectorAll('.dots button').forEach((b, i) => (i === S.slide ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));\n}\nlet slideTimer;\nfunction restartSlides() { clearInterval(slideTimer); slideTimer = setInterval(() => { if (document.hidden || !$('.hero')) return; S.slide = (S.slide + 1) % SLIDES.length; updateSlides(); }, 6000); }\n\n/* ───────── البدء ───────── */\nwindow.addEventListener('pageshow', (ev) => { if (ev.persisted && S.busy) { S.busy = false; render(); } });\nsetInterval(() => {\n  if (document.hidden || !S.loaded || S.guest) return;\n  if (S.orders.some((o) => o.status === 'pending' || o.status === 'paid')) refresh().catch(() => {});\n}, 20000);\n\nrestartSlides();\nrefresh().then(handleReturn).catch((e) => {\n  app.innerHTML = `<div class=\"boot\"><div class=\"empty\"><p>${esc(e.message)}</p><button class=\"btn sm\" onclick=\"location.reload()\">حاول مرة أخرى</button></div></div>`;\n});\n"},"/admin.html":{"type":"text/html; charset=utf-8","body":"<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n  <meta name=\"robots\" content=\"noindex,nofollow\">\n  <meta name=\"theme-color\" content=\"#141129\">\n  <title>إدارة المتجر</title>\n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n  <link href=\"https://fonts.googleapis.com/css2?family=Readex+Pro:wght@300..700&display=swap\" rel=\"stylesheet\">\n  <link rel=\"stylesheet\" href=\"/app.css\">\n  <style>\n    body { padding-bottom: 48px; }\n    #adm { max-width: 980px; margin: 0 auto; padding: 18px 16px 0; }\n    .bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }\n    .bar h1 { font-size: 22px; }\n    .tabs { display: flex; gap: 8px; overflow-x: auto; margin: 0 -16px 18px; padding: 0 16px; scrollbar-width: none; }\n    .tabs::-webkit-scrollbar { display: none; }\n    .tabs .cat { position: relative; }\n    .badge { display: inline-block; min-width: 20px; height: 20px; padding: 0 6px; margin-inline-start: 6px; border-radius: 999px; background: var(--star); color: #3a2a00; font-size: 12px; line-height: 20px; text-align: center; font-weight: 600; }\n    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }\n    @media (min-width: 720px) { .stats { grid-template-columns: repeat(4, 1fr); } }\n    .stat { background: var(--surface); border-radius: 18px; padding: 14px 16px; text-align: start; display: block; width: 100%; }\n    .stat b { display: block; font-size: 24px; font-weight: 600; direction: ltr; text-align: right; font-variant-numeric: tabular-nums; }\n    .stat span { color: var(--muted); font-size: 13px; }\n    button.stat:active { transform: scale(.98); }\n    .alert { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; padding: 12px 14px; border-radius: 16px; background: rgba(255, 197, 61, .13); color: var(--star); }\n    .alert .btn { flex: none; }\n    .alert.ok { background: rgba(95, 240, 207, .1); color: var(--mint); }\n    .alert.bad { background: rgba(255, 138, 152, .12); color: var(--danger); }\n    .card { background: var(--surface); border-radius: 20px; padding: 14px 16px; }\n    .card + .card { margin-top: 10px; }\n    .card .top { display: flex; align-items: center; gap: 12px; }\n    .card .grow { flex: 1; min-width: 0; }\n    .nm { font-weight: 500; line-height: 1.4; }\n    .ltr { direction: ltr; unicode-bidi: plaintext; text-align: right; }\n    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }\n    .inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }\n    .inline.end { justify-content: flex-end; }\n    textarea, .in {\n      width: 100%; border: 0; border-radius: 14px; background: var(--surface-2); color: var(--text);\n      padding: 12px 14px; font-size: 15px; outline: 0; min-height: 46px;\n    }\n    textarea { min-height: 84px; resize: vertical; direction: ltr; text-align: left; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 14px; }\n    .in.num { direction: ltr; text-align: left; }\n    textarea:focus, .in:focus { box-shadow: 0 0 0 2px var(--mint); }\n    .in.sm { width: 110px; }\n    .in.md { flex: 1; min-width: 140px; width: auto; }\n    .btn.sm.danger { background: rgba(255, 138, 152, .16); color: var(--danger); }\n    .btn.sm.warn { background: rgba(255, 197, 61, .16); color: var(--star); }\n    .plan-row { padding: 12px 0; border-top: 1px solid var(--line); }\n    .plan-row:first-of-type { border-top: 0; }\n    .plan-row .line { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }\n    .check { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 14px; cursor: pointer; }\n    .check input { width: 18px; height: 18px; accent-color: var(--mint); }\n    .stockline { color: var(--muted); font-size: 13px; }\n    .stockline.low { color: var(--danger); }\n    details.form { margin-bottom: 14px; }\n    details.form > summary { list-style: none; cursor: pointer; }\n    details.form > summary::-webkit-details-marker { display: none; }\n    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }\n    .grid2 .full { grid-column: 1 / -1; }\n    .login { max-width: 420px; margin: 12vh auto 0; }\n    .login h1 { margin-bottom: 6px; }\n    .hint { color: var(--muted); font-size: 13px; margin: 6px 0 0; }\n    .empty-line { color: var(--muted); padding: 24px 0; text-align: center; }\n    .pill.bad { background: rgba(255, 138, 152, .15); color: var(--danger); }\n    .toprow { display: flex; align-items: center; justify-content: space-between; gap: 10px; }\n    .mt { margin-top: 12px; }\n  </style>\n</head>\n<body>\n  <div id=\"adm\"></div>\n  <div id=\"toast\" role=\"status\"></div>\n<script>\n'use strict';\nconst $ = (s) => document.querySelector(s);\nconst root = $('#adm');\nconst esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[c]);\nconst usd = (c) => `$${(c / 100).toFixed(2)}`;\nconst fmtDate = (t) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(t * 1000));\nconst store = {\n  get() { try { return localStorage.getItem('adm') || ''; } catch { return ''; } },\n  set(v) { try { v ? localStorage.setItem('adm', v) : localStorage.removeItem('adm'); } catch {} },\n};\nlet token = store.get();\nconst S = { tab: 'overview', ov: null, orders: [], ostatus: 'pending', cat: null, users: [], q: '', topups: [], armed: null };\n\nlet tt;\nfunction toast(msg, err) {\n  const el = $('#toast');\n  el.textContent = msg; el.className = 'show' + (err ? ' err' : '');\n  clearTimeout(tt); tt = setTimeout(() => { el.className = ''; }, 3200);\n}\n\nasync function api(path, body) {\n  const h = { 'content-type': 'application/json' };\n  if (token) h.authorization = 'Bearer ' + token;\n  const r = await fetch('/api/admin' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });\n  const j = await r.json().catch(() => ({}));\n  if (!r.ok) {\n    if (r.status === 401 && token) { token = ''; store.set(''); renderLogin('انتهت الجلسة. سجّل الدخول من جديد'); }\n    throw new Error(j.error || 'تعذّر إكمال الطلب');\n  }\n  return j;\n}\n\n/* زر بخطوتين بدل confirm() */\nfunction armed(id) { return S.armed === id; }\nfunction arm(id) { S.armed = id; setTimeout(() => { if (S.armed === id) { S.armed = null; show(); } }, 3500); show(); }\n\n/* ───────── تسجيل الدخول ───────── */\nfunction renderLogin(note) {\n  root.innerHTML = `<div class=\"login\">\n    <h1>إدارة المتجر</h1>\n    <p class=\"muted\">${esc(note || 'اكتب كلمة سر الإدارة.')}</p>\n    <form id=\"lf\" class=\"form\" novalidate>\n      <label class=\"field\"><span>كلمة السر</span><input id=\"pw\" type=\"password\" autocomplete=\"current-password\" dir=\"ltr\" required></label>\n      <div class=\"err\" id=\"le\" role=\"alert\"></div>\n      <button class=\"btn\" type=\"submit\">دخول</button>\n    </form></div>`;\n  $('#lf').addEventListener('submit', async (e) => {\n    e.preventDefault();\n    const b = e.target.querySelector('button'); b.disabled = true; $('#le').textContent = '';\n    try {\n      const r = await api('/login', { password: $('#pw').value });\n      token = r.token; store.set(token); start();\n    } catch (er) { $('#le').textContent = er.message; b.disabled = false; }\n  });\n}\n\n/* ───────── الإطار ───────── */\nconst TABS = [['overview', 'نظرة عامة'], ['orders', 'الطلبات'], ['products', 'المنتجات'], ['users', 'العملاء'], ['topups', 'الشحنات']];\nfunction shell(inner) {\n  const pend = S.ov?.orders.pending || 0;\n  return `<div class=\"bar\"><h1>إدارة المتجر</h1><button class=\"btn ghost sm\" data-act=\"logout\">خروج</button></div>\n    <div class=\"tabs\" role=\"tablist\">${TABS.map(([k, n]) => `<button class=\"cat\" role=\"tab\" data-act=\"tab\" data-t=\"${k}\" aria-pressed=\"${S.tab === k}\">${n}${k === 'orders' && pend ? `<span class=\"badge\">${pend}</span>` : ''}</button>`).join('')}</div>\n    <div id=\"content\">${inner}</div>`;\n}\n\nfunction show() {\n  const views = { overview: vOverview, orders: vOrders, products: vProducts, users: vUsers, topups: vTopups };\n  const keepScroll = window.scrollY;\n  const focus = document.activeElement?.id;\n  const saved = [...root.querySelectorAll('input[id],textarea[id],select[id]')].map((el) => [el.id, el.type === 'checkbox' ? el.checked : el.value]);\n  const open = [...root.querySelectorAll('details[open]')].map((d) => d.querySelector('[id]')?.id).filter(Boolean);\n  root.innerHTML = shell(views[S.tab]());\n  for (const [id, v] of saved) {\n    const el = document.getElementById(id);\n    if (!el || id === 'uq') continue;\n    if (el.type === 'checkbox') el.checked = v; else if (v !== '' ) el.value = v;\n  }\n  for (const id of open) { const d = document.getElementById(id)?.closest('details'); if (d) d.open = true; }\n  window.scrollTo(0, keepScroll);\n  if (focus) $('#' + focus)?.focus();\n}\n\n/* ───────── نظرة عامة ───────── */\nfunction vOverview() {\n  const o = S.ov;\n  if (!o) return '<div class=\"skeleton\"></div>';\n  const stat = (n, label, act) => `<${act ? 'button' : 'div'} class=\"stat\" ${act ? `data-act=\"${act}\"` : ''}><b>${n}</b><span>${label}</span></${act ? 'button' : 'div'}>`;\n  return `\n    <div class=\"stats\">\n      ${stat(usd(o.salesTodayCents), 'مبيعات آخر 24 ساعة')}\n      ${stat(usd(o.salesCents), 'إجمالي المبيعات')}\n      ${stat(o.orders.pending, 'طلبات تنتظر التسليم', 'go-pending')}\n      ${stat(usd(o.walletsCents), 'أرصدة العملاء')}\n      ${stat(usd(o.topupsCents), 'شحنات Sifalo')}\n      ${stat(o.stars, 'نجوم مستلمة')}\n      ${stat(o.users, 'العملاء')}\n      ${stat(o.orders.delivered, 'طلبات مسلّمة')}\n    </div>\n    ${o.orders.pending ? `<div class=\"alert\"><span>${o.orders.pending} طلب بانتظار تسليمك</span><button class=\"btn sm\" data-act=\"go-pending\">افتح الطلبات</button></div>` : ''}\n    ${o.pendingTopups ? `<div class=\"alert\"><span>${o.pendingTopups} شحنة لم يتأكد دفعها بعد</span><button class=\"btn sm\" data-act=\"go-topups\">راجعها</button></div>` : ''}\n    <div class=\"alert ${o.sifalo ? 'ok' : 'bad'}\"><span>${o.sifalo ? `Sifalo Pay مفعّل${o.staging ? ' (وضع التجربة)' : ''}` : 'Sifalo Pay غير مفعّل: أضف SIFALO_API_USER وSIFALO_API_KEY في Cloudflare'}</span></div>\n    ${o.sifalo ? '<div class=\"card\"><button class=\"btn sm\" data-act=\"sifalotest\">فحص اتصال Sifalo</button><pre id=\"stest\" class=\"ltr\" style=\"white-space:pre-wrap;margin:10px 0 0;font-size:12px;direction:ltr;text-align:left\"></pre></div>' : ''}\n    <div class=\"alert ${o.telegram ? 'ok' : ''}\"><span>${o.telegram ? 'بوت تيليجرام مرتبط' : 'بوت تيليجرام غير مضبوط (اختياري)'}</span></div>\n    ${o.lowStock.length ? `<h2>مخزون منخفض</h2>${o.lowStock.map((l) => `<div class=\"card\"><div class=\"toprow\"><span class=\"nm ltr\">${esc(l.name)} — ${esc(l.label)}</span><span class=\"pill ${l.stock ? 'warn' : 'bad'}\">${l.stock ? `متبقي ${l.stock}` : 'نفد'}</span></div></div>`).join('')}` : ''}`;\n}\n\n/* ───────── الطلبات ───────── */\nconst ST = { pending: ['قيد التجهيز', 'warn'], delivered: ['تم التسليم', 'ok'], refunded: ['مسترد', ''] };\nfunction vOrders() {\n  const fl = [['pending', 'قيد التجهيز'], ['delivered', 'تم التسليم'], ['refunded', 'مسترد'], ['', 'الكل']];\n  const list = S.orders.map((o) => {\n    const [t, c] = ST[o.status] || [o.status, ''];\n    return `<div class=\"card\">\n      <div class=\"top\"><div class=\"grow\"><div class=\"nm ltr\">${esc(o.product)}</div><div class=\"muted small\">${esc(o.plan)} — <bdi>${usd(o.price)}</bdi> — طلب <bdi>#${o.id}</bdi></div></div><span class=\"pill ${c}\">${t}</span></div>\n      <div class=\"muted small mt ltr\">${esc(o.who)} · ${fmtDate(o.created)} · ${o.method === 'stars' ? 'نجوم' : 'محفظة'}</div>\n      ${o.status === 'pending' ? `\n        <label class=\"field mt\"><span>بيانات الاشتراك التي تصل العميل</span><textarea id=\"dl${o.id}\" placeholder=\"email:password أو كود التفعيل\"></textarea></label>\n        <div class=\"inline end\">\n          <button class=\"btn sm danger\" data-act=\"refund\" data-id=\"${o.id}\">${armed('r' + o.id) ? 'اضغط للتأكيد' : 'استرداد'}</button>\n          <button class=\"btn sm\" data-act=\"deliver\" data-id=\"${o.id}\">تسليم</button>\n        </div>` : ''}\n      ${o.status === 'delivered' ? `\n        <div class=\"code mt\"><pre>${esc(o.delivery)}</pre></div>\n        <div class=\"inline end\"><button class=\"btn sm danger\" data-act=\"refund\" data-id=\"${o.id}\">${armed('r' + o.id) ? 'اضغط للتأكيد' : 'استرداد للمحفظة'}</button></div>` : ''}\n    </div>`;\n  }).join('');\n  return `<div class=\"chips\">${fl.map(([k, n]) => `<button class=\"cat\" data-act=\"ofilter\" data-s=\"${k}\" aria-pressed=\"${S.ostatus === k}\">${n}</button>`).join('')}</div>\n    ${list || '<div class=\"empty-line\">لا توجد طلبات هنا</div>'}`;\n}\n\n/* ───────── المنتجات ───────── */\nfunction vProducts() {\n  const c = S.cat;\n  if (!c) return '<div class=\"skeleton\"></div>';\n  const add = `<details class=\"form\"><summary><span class=\"btn ghost sm\" style=\"display:inline-flex\">إضافة منتج جديد</span></summary>\n    <div class=\"card mt\"><div class=\"grid2\">\n      <input class=\"in\" id=\"np-name\" placeholder=\"اسم المنتج (مثل Netflix)\" dir=\"ltr\">\n      <select class=\"in\" id=\"np-cat\">${c.categories.map((k) => `<option value=\"${k.key}\">${esc(k.name)}</option>`).join('')}</select>\n      <input class=\"in\" id=\"np-color\" placeholder=\"اللون #FF5577\" dir=\"ltr\" value=\"#7C6CFF\">\n      <input class=\"in\" id=\"np-glyph\" placeholder=\"رمز: حرف أو حرفان\" maxlength=\"2\" dir=\"ltr\">\n      <input class=\"in full\" id=\"np-desc\" placeholder=\"وصف قصير بالعربي\">\n      <button class=\"btn full\" data-act=\"addproduct\">إضافة المنتج</button>\n    </div></div></details>`;\n  const items = c.products.map((p) => `<div class=\"card\">\n    <div class=\"top\">\n      <span class=\"glyph sm\" style=\"--c:${esc(p.color)};--ink:#14112b\">${esc(p.glyph)}</span>\n      <div class=\"grow\"><div class=\"nm ltr\">${esc(p.name)}</div><div class=\"muted small\">${esc(p.desc)}</div></div>\n      <button class=\"btn sm ${p.active ? 'ghost' : 'warn'}\" data-act=\"ptoggle\" data-id=\"${p.id}\" data-on=\"${p.active ? 0 : 1}\">${p.active ? 'إخفاء' : 'إظهار'}</button>\n    </div>\n    <div class=\"mt\">${p.plans.map((x) => `<div class=\"plan-row\">\n      <div class=\"line\">\n        <span class=\"nm\" style=\"min-width:90px\">${esc(x.label)}</span>\n        <input class=\"in sm num\" id=\"pr${x.id}\" type=\"number\" min=\"0.01\" step=\"0.01\" inputmode=\"decimal\" value=\"${(x.price / 100).toFixed(2)}\" aria-label=\"السعر بالدولار\">\n        <label class=\"check\"><input type=\"checkbox\" id=\"mn${x.id}\" ${x.manual ? 'checked' : ''}>تسليم يدوي</label>\n        <button class=\"btn sm\" data-act=\"psave\" data-id=\"${x.id}\">حفظ</button>\n        <button class=\"btn sm ${x.active ? 'ghost' : 'warn'}\" data-act=\"plantoggle\" data-id=\"${x.id}\" data-on=\"${x.active ? 0 : 1}\">${x.active ? 'إخفاء' : 'إظهار'}</button>\n      </div>\n      <div class=\"stockline ${!x.manual && x.stock <= 2 ? 'low' : ''} mt\">المخزون: ${x.stock}${x.manual ? ' (يُباع حتى بدون مخزون)' : ''}</div>\n      <details class=\"mt\"><summary class=\"stockline\" style=\"cursor:pointer\">إضافة مخزون</summary>\n        <textarea id=\"st${x.id}\" placeholder=\"كل سطر = حساب أو كود لعميل واحد\"></textarea>\n        <div class=\"inline end\"><button class=\"btn sm\" data-act=\"addstock\" data-id=\"${x.id}\">إضافة</button></div>\n      </details>\n    </div>`).join('')}</div>\n    <details class=\"mt\"><summary class=\"stockline\" style=\"cursor:pointer\">إضافة باقة</summary>\n      <div class=\"inline\">\n        <input class=\"in md\" id=\"nl${p.id}\" placeholder=\"اسم الباقة (مثل 3 أشهر)\">\n        <input class=\"in sm num\" id=\"np${p.id}\" type=\"number\" min=\"0.01\" step=\"0.01\" inputmode=\"decimal\" placeholder=\"السعر $\">\n        <label class=\"check\"><input type=\"checkbox\" id=\"nm${p.id}\" checked>يدوي</label>\n        <button class=\"btn sm\" data-act=\"addplan\" data-id=\"${p.id}\">إضافة</button>\n      </div>\n    </details>\n  </div>`).join('');\n  return add + items;\n}\n\n/* ───────── العملاء ───────── */\nfunction vUsers() {\n  return `<input class=\"in\" id=\"uq\" type=\"search\" placeholder=\"ابحث بالبريد أو الاسم أو الرقم\" value=\"${esc(S.q)}\" autocomplete=\"off\">\n    <div class=\"mt\">${S.users.map((u) => `<div class=\"card\">\n      <div class=\"top\"><div class=\"grow\"><div class=\"nm ltr\">${esc(u.label)}</div><div class=\"muted small\">${esc(u.name)} · ${u.orders} طلب · ${fmtDate(u.created)}</div></div><b class=\"amt\">${usd(u.balance)}</b></div>\n      <details class=\"mt\"><summary class=\"stockline\" style=\"cursor:pointer\">تعديل الرصيد</summary>\n        <div class=\"inline\">\n          <input class=\"in sm num\" id=\"ca${u.id}\" type=\"number\" step=\"0.01\" inputmode=\"decimal\" placeholder=\"± بالدولار\">\n          <input class=\"in md\" id=\"cn${u.id}\" placeholder=\"ملاحظة (اختياري)\">\n          <button class=\"btn sm\" data-act=\"credit\" data-id=\"${u.id}\">طبّق</button>\n        </div>\n        <p class=\"hint\">اكتب رقمًا موجبًا للإضافة أو سالبًا للخصم.</p>\n      </details></div>`).join('') || '<div class=\"empty-line\">لا يوجد عملاء مطابقون</div>'}</div>`;\n}\n\n/* ───────── الشحنات ───────── */\nfunction vTopups() {\n  const ST2 = { paid: ['مدفوعة', 'ok'], pending: ['بانتظار التأكيد', 'warn'], failed: ['فشلت', 'bad'] };\n  return S.topups.map((t) => {\n    const [n, c] = ST2[t.status] || [t.status, ''];\n    return `<div class=\"card\">\n      <div class=\"top\"><div class=\"grow\"><div class=\"nm ltr\">${esc(t.who)}</div><div class=\"muted small\">${fmtDate(t.created)}</div></div><b class=\"amt\">${usd(t.cents)}</b><span class=\"pill ${c}\">${n}</span></div>\n      ${t.status !== 'paid' ? `<div class=\"inline end\">\n        ${t.status === 'pending' ? `<button class=\"btn sm\" data-act=\"tverify\" data-ref=\"${t.ref}\">تحقق من الدفع</button>` : ''}\n        <button class=\"btn sm warn\" data-act=\"tcredit\" data-ref=\"${t.ref}\">${armed('c' + t.ref) ? 'أكّد أنك رأيت المبلغ في Sifalo' : 'إضافة يدوية'}</button>\n      </div>` : ''}</div>`;\n  }).join('') || '<div class=\"empty-line\">لا توجد شحنات بعد</div>';\n}\n\n/* ───────── التحميل ───────── */\nasync function load(tab) {\n  try {\n    if (tab === 'overview' || !S.ov) S.ov = await api('/overview');\n    if (tab === 'orders') S.orders = (await api('/orders?status=' + S.ostatus)).orders;\n    if (tab === 'products') S.cat = await api('/catalog');\n    if (tab === 'users') S.users = (await api('/users?q=' + encodeURIComponent(S.q))).users;\n    if (tab === 'topups') S.topups = (await api('/topups')).topups;\n  } catch (e) { if (token) toast(e.message, true); }\n  show();\n}\nasync function go(tab) { S.tab = tab; S.armed = null; show(); await load(tab); window.scrollTo(0, 0); }\n\nasync function act(fn, okMsg, reload) {\n  try { await fn(); if (okMsg) toast(okMsg); S.ov = null; await load(reload || S.tab); }\n  catch (e) { toast(e.message, true); }\n}\n\ndocument.addEventListener('click', (e) => {\n  const el = e.target.closest('[data-act]');\n  if (!el) return;\n  const d = el.dataset;\n  const num = (id) => $('#' + id)?.value;\n  switch (d.act) {\n    case 'tab': go(d.t); break;\n    case 'go-pending': S.ostatus = 'pending'; go('orders'); break;\n    case 'go-topups': go('topups'); break;\n    case 'sifalotest': {\n      const el = $('#stest'); el.textContent = 'جارٍ الفحص...';\n      api('/sifalo/test', {}).then((r) => { el.textContent = (r.ok ? '✅ الاتصال يعمل، Sifalo أعطت رابط دفع' : '❌ فشل الاتصال') + `\\nالبيئة: ${r.env}\\nالخادم: ${r.host}\\nالمستخدم: ${r.user}\\nالحالة: ${r.status}\\nرد Sifalo: ${r.response}`; }).catch((e) => { el.textContent = '❌ ' + e.message; });\n      break;\n    }\n    case 'logout': api('/logout', {}).catch(() => {}); token = ''; store.set(''); renderLogin(); break;\n    case 'ofilter': S.ostatus = d.s; load('orders'); break;\n    case 'deliver': act(() => api('/deliver', { id: +d.id, text: num('dl' + d.id) }), 'تم التسليم', 'orders'); break;\n    case 'refund':\n      if (!armed('r' + d.id)) return arm('r' + d.id);\n      S.armed = null; act(() => api('/refund', { id: +d.id }), 'تم الاسترداد إلى المحفظة', 'orders'); break;\n    case 'psave': act(() => api('/plan/update', { id: +d.id, price: num('pr' + d.id), manual: $('#mn' + d.id).checked }), 'تم الحفظ', 'products'); break;\n    case 'plantoggle': act(() => api('/plan/update', { id: +d.id, active: +d.on }), 'تم', 'products'); break;\n    case 'ptoggle': act(() => api('/product/update', { id: +d.id, active: +d.on }), 'تم', 'products'); break;\n    case 'addstock': act(() => api('/stock', { plan_id: +d.id, lines: num('st' + d.id) }), 'أُضيف المخزون', 'products'); break;\n    case 'addplan': act(() => api('/plan/add', { product_id: +d.id, label: num('nl' + d.id), price: num('np' + d.id), manual: $('#nm' + d.id).checked }), 'أُضيفت الباقة', 'products'); break;\n    case 'addproduct': act(() => api('/product/add', { name: num('np-name'), cat: num('np-cat'), color: num('np-color'), glyph: num('np-glyph'), desc: num('np-desc') }), 'أُضيف المنتج، أضف له باقة الآن', 'products'); break;\n    case 'credit': act(() => api('/credit', { user_id: +d.id, amount: num('ca' + d.id), note: num('cn' + d.id) }), 'تم تعديل الرصيد', 'users'); break;\n    case 'tverify': act(async () => { const r = await api('/topup/verify', { ref: d.ref }); toast(r.status === 'paid' ? 'تأكد الدفع وأُضيف الرصيد' : 'لم يتأكد الدفع بعد في Sifalo'); }, '', 'topups'); break;\n    case 'tcredit':\n      if (!armed('c' + d.ref)) return arm('c' + d.ref);\n      S.armed = null; act(() => api('/topup/credit', { ref: d.ref }), 'أُضيف الرصيد يدويًا', 'topups'); break;\n  }\n});\n\nlet qt;\ndocument.addEventListener('input', (e) => {\n  if (e.target.id === 'uq') { S.q = e.target.value; clearTimeout(qt); qt = setTimeout(() => load('users'), 300); }\n});\n\nasync function start() {\n  if (!token) return renderLogin();\n  S.tab = 'overview'; S.ov = null; show(); await load('overview');\n}\nstart();\n</script>\n</body>\n</html>\n"}};

/* ───────── نقطة الدخول ───────── */
export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/') || pathname.startsWith('/setup/') || pathname === '/tg') {
      return env.STORE.get(env.STORE.idFromName('main')).fetch(request);
    }
    const isAdmin = pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html';
    const a = ASSETS[isAdmin ? '/admin.html' : pathname === '/' ? '/index.html' : pathname];
    if (!a || (request.method !== 'GET' && request.method !== 'HEAD')) return new Response('Not found', { status: 404 });
    const headers = { 'content-type': a.type, 'cache-control': a.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300', 'x-content-type-options': 'nosniff' };
    if (isAdmin) Object.assign(headers, { 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' });
    return new Response(a.body, { headers });
  },
};
