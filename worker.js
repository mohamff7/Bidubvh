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
const ASSETS = {"/index.html":{"type":"text/html; charset=utf-8","body":"<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no\">\n  <meta name=\"theme-color\" content=\"#141129\">\n  <title>المتجر</title>\n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n  <link href=\"https://fonts.googleapis.com/css2?family=Readex+Pro:wght@300..700&display=swap\" rel=\"stylesheet\">\n  <link rel=\"stylesheet\" href=\"/app.css\">\n  <script src=\"https://telegram.org/js/telegram-web-app.js\"></script>\n</head>\n<body>\n  <main id=\"view\" aria-live=\"polite\"></main>\n\n  <nav class=\"dock\" aria-label=\"التنقل\">\n    <button data-act=\"tab\" data-tab=\"store\" class=\"dock-btn\">\n      <svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"13.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"3.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"13.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"2\"/></svg>\n      <span>المتجر</span>\n    </button>\n    <button data-act=\"tab\" data-tab=\"wallet\" class=\"dock-btn\">\n      <svg viewBox=\"0 0 24 24\"><path d=\"M4 7.5A2.5 2.5 0 0 1 6.5 5H18a2 2 0 0 1 2 2v1.5\"/><path d=\"M4 7.5V17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 1 4 6.5\"/><circle cx=\"16\" cy=\"14\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/></svg>\n      <span>المحفظة</span>\n    </button>\n    <button data-act=\"tab\" data-tab=\"orders\" class=\"dock-btn\">\n      <svg viewBox=\"0 0 24 24\"><path d=\"M6 3.5h12v17l-3-1.8-3 1.8-3-1.8-3 1.8z\"/><path d=\"M9.5 8.5h5M9.5 12h5\"/></svg>\n      <span>طلباتي</span>\n    </button>\n  </nav>\n\n  <div id=\"sheet-root\"></div>\n  <div id=\"toast\" role=\"status\"></div>\n  <script src=\"/app.js\"></script>\n</body>\n</html>\n"},"/app.css":{"type":"text/css; charset=utf-8","body":":root {\n  --bg: #141129;\n  --surface: #1e1a3c;\n  --surface-2: #2a2552;\n  --line: #383068;\n  --text: #f2efff;\n  --muted: #a59dcb;\n  --mint: #5ff0cf;\n  --mint-deep: #46d9b6;\n  --mint-ink: #0c2b27;\n  --star: #ffc53d;\n  --danger: #ff8a98;\n  --dock-h: 68px;\n  --safe-b: env(safe-area-inset-bottom, 0px);\n  font-family: 'Readex Pro', system-ui, -apple-system, 'Segoe UI', Tahoma, sans-serif;\n}\n\n* { box-sizing: border-box; }\nhtml { color-scheme: dark; }\nbody {\n  margin: 0;\n  background: var(--bg);\n  color: var(--text);\n  font-size: 15px;\n  line-height: 1.6;\n  -webkit-tap-highlight-color: transparent;\n  -webkit-font-smoothing: antialiased;\n  padding-bottom: calc(var(--dock-h) + var(--safe-b) + 24px);\n}\nbutton, input { font: inherit; color: inherit; }\nbutton { border: 0; background: none; padding: 0; cursor: pointer; text-align: inherit; }\nbdi, .num { font-variant-numeric: tabular-nums; }\nsvg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }\n:focus-visible { outline: 2px solid var(--mint); outline-offset: 2px; }\n\n#view { padding: 20px 18px 0; max-width: 560px; margin: 0 auto; min-height: 60vh; }\n\n/* ───── العناوين ───── */\n.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }\nh1 { margin: 0; font-size: 24px; font-weight: 600; line-height: 1.3; }\nh2 { margin: 28px 0 12px; font-size: 16px; font-weight: 500; color: var(--muted); }\n.muted { color: var(--muted); }\n.small { font-size: 13px; }\n\n.chip-wallet {\n  display: inline-flex; align-items: center; gap: 8px;\n  height: 40px; padding: 0 14px; border-radius: 999px;\n  background: var(--surface); font-weight: 500;\n}\n.chip-wallet::before { content: ''; width: 9px; height: 9px; border-radius: 50%; background: var(--mint); }\n\n/* ───── البحث والتصنيفات ───── */\n.search {\n  display: flex; align-items: center; gap: 10px;\n  background: var(--surface); border-radius: 16px; padding: 0 14px; height: 48px; color: var(--muted);\n}\n.search input { flex: 1; min-width: 0; background: none; border: 0; outline: 0; height: 100%; color: var(--text); }\n.search input::placeholder { color: var(--muted); }\n.search:focus-within { box-shadow: 0 0 0 2px var(--mint); }\n\n.cats { display: flex; gap: 8px; overflow-x: auto; margin: 14px -18px 18px; padding: 0 18px; scrollbar-width: none; }\n.cats::-webkit-scrollbar { display: none; }\n.cat {\n  flex: none; height: 38px; padding: 0 16px; border-radius: 999px;\n  background: var(--surface); color: var(--muted); font-weight: 400;\n}\n.cat[aria-pressed='true'] { background: var(--text); color: var(--bg); font-weight: 500; }\n\n/* ───── المنتجات ───── */\n.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }\n.tile {\n  display: flex; flex-direction: column; align-items: flex-start; gap: 4px;\n  background: var(--surface); border-radius: 22px; padding: 14px 14px 16px;\n  transition: transform .12s ease;\n}\n.tile:active { transform: scale(.97); }\n.tile[data-off='1'] { opacity: .5; }\n.glyph {\n  display: grid; place-items: center; flex: none;\n  width: 52px; height: 52px; border-radius: 16px; margin-bottom: 10px;\n  background: var(--c); color: var(--ink); font-weight: 700; font-size: 19px; line-height: 1; direction: ltr;\n}\n.glyph.sm { width: 44px; height: 44px; border-radius: 14px; margin: 0; font-size: 16px; }\n.tname { font-weight: 500; line-height: 1.3; direction: ltr; text-align: right; align-self: stretch; unicode-bidi: plaintext; }\n.tfrom { color: var(--muted); font-size: 13px; }\n\n.empty { text-align: center; padding: 48px 16px; color: var(--muted); }\n.empty p { margin: 0 0 16px; }\n\n/* ───── الأزرار ───── */\n.btn {\n  display: flex; align-items: center; justify-content: center; gap: 8px;\n  width: 100%; min-height: 54px; padding: 0 20px; border-radius: 18px;\n  background: var(--mint); color: var(--mint-ink); font-weight: 600; font-size: 16px; text-align: center;\n  transition: transform .12s ease, opacity .12s ease;\n}\n.btn:active { transform: scale(.98); }\n.btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }\n.btn.ghost { background: var(--surface-2); color: var(--text); }\n.btn.sm { width: auto; min-height: 40px; border-radius: 14px; padding: 0 16px; font-size: 14px; }\n.star { color: var(--star); width: 1.05em; height: 1.05em; fill: currentColor; stroke: none; vertical-align: -0.15em; }\n\n/* ───── تذكرة المحفظة (العنصر المميز) ───── */\n.pass { --tear: rgba(12, 43, 39, .28); --n: 12px; filter: drop-shadow(0 14px 22px rgba(0, 0, 0, .28)); }\n.pass-top, .pass-bot { position: relative; }\n.pass-top {\n  border-radius: 26px 26px 0 0; padding: 22px 22px 22px;\n  --m: radial-gradient(circle var(--n) at 0 100%, #0000 97%, #000) left / 51% 100% no-repeat,\n        radial-gradient(circle var(--n) at 100% 100%, #0000 97%, #000) right / 51% 100% no-repeat;\n  -webkit-mask: var(--m); mask: var(--m);\n}\n.pass-bot {\n  border-radius: 0 0 26px 26px; padding: 18px 22px 20px;\n  --m: radial-gradient(circle var(--n) at 0 0, #0000 97%, #000) left / 51% 100% no-repeat,\n        radial-gradient(circle var(--n) at 100% 0, #0000 97%, #000) right / 51% 100% no-repeat;\n  -webkit-mask: var(--m); mask: var(--m);\n}\n.pass-bot::before {\n  content: ''; position: absolute; inset-inline: 22px; top: 0; border-top: 2px dashed var(--tear);\n}\n.pass.wallet .pass-top { background: var(--mint); color: var(--mint-ink); }\n.pass.wallet .pass-bot { background: var(--mint-deep); color: var(--mint-ink); }\n.pass .label { font-size: 14px; opacity: .75; }\n.balance { font-size: 52px; font-weight: 600; line-height: 1.15; margin: 2px 0 0; direction: ltr; text-align: right; font-variant-numeric: tabular-nums; }\n.rate { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }\n.pass.wallet .star { color: #7a4d00; }\n\n.pass.order { filter: none; }\n.pass.order .pass-top { background: var(--c); color: var(--ink); display: flex; align-items: center; gap: 14px; }\n.pass.order .glyph { background: var(--ink); color: var(--c); }\n.pass.order .pass-bot { background: var(--surface-2); color: var(--text); --tear: rgba(242, 239, 255, .22); }\n.pass.order .nm { font-weight: 600; font-size: 18px; line-height: 1.3; direction: ltr; text-align: right; unicode-bidi: plaintext; }\n.pass.order .pl { font-size: 14px; opacity: .8; }\n\n/* ───── باقات الشحن ───── */\n.packs { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }\n.pack {\n  display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; border-radius: 18px;\n  background: var(--surface); box-shadow: inset 0 0 0 2px transparent;\n}\n.pack b { font-size: 22px; font-weight: 600; direction: ltr; text-align: right; }\n.pack[aria-checked='true'] { background: rgba(95, 240, 207, .12); box-shadow: inset 0 0 0 2px var(--mint); }\n.pay-wrap { margin-top: 14px; }\n\n/* ───── القوائم ───── */\n.rows { display: flex; flex-direction: column; }\n.row { display: flex; align-items: center; gap: 12px; padding: 12px 0; }\n.row + .row { border-top: 1px solid var(--line); }\n.row .grow { flex: 1; min-width: 0; }\n.row .t { font-weight: 500; line-height: 1.4; }\n.amt { font-weight: 500; direction: ltr; font-variant-numeric: tabular-nums; }\n.amt.in { color: var(--mint); }\n\n.order-row { width: 100%; background: var(--surface); border-radius: 20px; padding: 12px 14px; }\n.order-row + .order-row { margin-top: 10px; border-top: 0; }\n.pill { display: inline-block; font-size: 12px; padding: 2px 10px; border-radius: 999px; background: var(--surface-2); color: var(--muted); white-space: nowrap; }\n.pill.ok { background: rgba(95, 240, 207, .16); color: var(--mint); }\n.pill.warn { background: rgba(255, 197, 61, .16); color: var(--star); }\n\n/* ───── اللوح السفلي ───── */\n.scrim { position: fixed; inset: 0; background: rgba(8, 6, 22, .62); z-index: 20; animation: fade .2s ease; }\n.sheet {\n  position: fixed; inset-inline: 0; bottom: 0; z-index: 21; margin: 0 auto; max-width: 560px;\n  max-height: 90vh; overflow-y: auto; overscroll-behavior: contain;\n  background: var(--surface); border-radius: 30px 30px 0 0;\n  padding: 10px 20px calc(20px + var(--safe-b));\n  animation: rise .3s cubic-bezier(.2, .8, .2, 1);\n}\n.grab { width: 40px; height: 4px; border-radius: 4px; background: var(--line); margin: 0 auto 16px; }\n.sheet-head { display: flex; align-items: center; gap: 14px; margin-bottom: 6px; }\n.sheet-head .glyph { margin: 0; }\n.sheet h3 { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; direction: ltr; text-align: right; unicode-bidi: plaintext; }\n.sheet p.desc { margin: 4px 0 18px; color: var(--muted); }\n.sheet .gap { height: 14px; }\n\n.plans { display: flex; flex-direction: column; gap: 8px; }\n.plan {\n  display: flex; align-items: center; justify-content: space-between; gap: 12px;\n  padding: 14px 16px; border-radius: 16px; background: var(--surface-2); box-shadow: inset 0 0 0 2px transparent;\n}\n.plan[aria-checked='true'] { box-shadow: inset 0 0 0 2px var(--mint); }\n.plan[aria-disabled='true'] { opacity: .45; cursor: not-allowed; }\n.plan .p { text-align: left; direction: ltr; line-height: 1.3; }\n.plan .p b { font-weight: 600; }\n\n.methods { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }\n.method {\n  padding: 12px 14px; border-radius: 16px; background: var(--surface-2); box-shadow: inset 0 0 0 2px transparent; line-height: 1.4;\n}\n.method[aria-checked='true'] { box-shadow: inset 0 0 0 2px var(--mint); }\n.method .s { display: block; font-size: 13px; color: var(--muted); }\n.method .s.low { color: var(--danger); }\n.sheet .sec { margin: 18px 0 8px; font-size: 14px; color: var(--muted); }\n\n.code {\n  display: flex; align-items: center; gap: 10px; background: rgba(0, 0, 0, .22); border-radius: 14px; padding: 12px 14px;\n}\n.code pre {\n  flex: 1; margin: 0; min-width: 0; font: 500 14px/1.6 ui-monospace, 'SF Mono', Menlo, Consolas, monospace;\n  direction: ltr; text-align: left; white-space: pre-wrap; word-break: break-all; user-select: all;\n}\n.note { margin: 0; color: var(--muted); font-size: 14px; }\n\n/* ───── شريط التنقل ───── */\n.dock {\n  position: fixed; inset-inline: 0; bottom: 0; z-index: 10;\n  display: flex; justify-content: center; gap: 6px;\n  padding: 8px 14px calc(8px + var(--safe-b)); background: var(--bg);\n  border-top: 1px solid var(--line);\n}\n.dock-btn {\n  flex: 1; max-width: 170px; height: 52px; border-radius: 18px;\n  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;\n  color: var(--muted); font-size: 12px;\n}\n.dock-btn svg { width: 22px; height: 22px; }\n.dock-btn[aria-current='page'] { background: var(--surface); color: var(--mint); }\n\n#toast {\n  position: fixed; inset-inline: 16px; bottom: calc(var(--dock-h) + var(--safe-b) + 16px); z-index: 30;\n  margin: 0 auto; max-width: 420px; padding: 12px 16px; border-radius: 16px;\n  background: var(--text); color: var(--bg); font-weight: 500; text-align: center;\n  opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity .2s ease, transform .2s ease;\n}\n#toast.show { opacity: 1; transform: none; }\n#toast.err { background: var(--danger); color: #3a0a12; }\n\n.spin { width: 18px; height: 18px; border-radius: 50%; border: 2.5px solid currentColor; border-top-color: transparent; animation: turn .7s linear infinite; }\n.skeleton { height: 120px; border-radius: 22px; background: var(--surface); opacity: .6; }\n\n@keyframes rise { from { transform: translateY(100%); } to { transform: none; } }\n@keyframes fade { from { opacity: 0; } to { opacity: 1; } }\n@keyframes turn { to { transform: rotate(360deg); } }\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }\n}\n\n/* ───── ويب: تسجيل الدخول والشاشات الواسعة ───── */\n.narrow { max-width: 560px; margin: 0 auto; }\n.narrow .gap { height: 16px; }\n.auth { padding-top: 8vh; }\n.auth h1 { font-size: 30px; margin-bottom: 6px; }\n.auth > p { margin: 0 0 24px; }\n.form { display: flex; flex-direction: column; gap: 14px; }\n.field { display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: var(--muted); }\n.field input {\n  height: 52px; padding: 0 16px; border: 0; border-radius: 16px; background: var(--surface);\n  color: var(--text); font-size: 16px; outline: 0;\n}\n.field input:focus { box-shadow: 0 0 0 2px var(--mint); }\n.err { min-height: 20px; color: var(--danger); font-size: 14px; }\n.linkbtn { display: block; margin: 18px auto 0; color: var(--mint); font-weight: 500; padding: 8px; }\n\n@media (min-width: 900px) {\n  #view { max-width: 1040px; padding-top: 36px; }\n  .grid { grid-template-columns: repeat(4, 1fr); gap: 16px; }\n  .search { max-width: 520px; }\n  .sheet {\n    inset: 50% auto auto 50%; transform: translate(-50%, -50%); width: min(520px, 92vw);\n    border-radius: 30px; padding-top: 22px; animation: fade .2s ease;\n  }\n  .grab { display: none; }\n  .tile { padding: 18px 18px 20px; }\n}\n\n.guest-chip { background: var(--mint); color: var(--mint-ink); }\n.guest-chip::before { display: none; }\n.muted-link { color: var(--muted); font-weight: 400; margin-top: 0; }\n"},"/app.js":{"type":"text/javascript; charset=utf-8","body":"'use strict';\n\nconst tg = window.Telegram?.WebApp;\nconst initData = tg?.initData || '';\nconst isTg = !!initData;\nconst tokenStore = {\n  get() { try { return localStorage.getItem('tok') || ''; } catch { return ''; } },\n  set(v) { try { v ? localStorage.setItem('tok', v) : localStorage.removeItem('tok'); } catch {} },\n};\nlet token = tokenStore.get();\nconst $ = (s) => document.querySelector(s);\nconst view = $('#view');\nconst sheetRoot = $('#sheet-root');\n\nconst state = {\n  tab: 'store', cat: 'all', q: '', topup: 10, busy: false, loaded: false,\n  me: { balance: 0, name: '' }, config: { starsPerUsd: 50, topups: [], support: '' },\n  categories: [], products: [], orders: [], ledger: [],\n  sheet: null, needLogin: false, guest: false, authNote: '', afterAuth: null, auth: { mode: 'login' },\n};\n\n/* ───────── أدوات ───────── */\nconst esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[c]);\nconst sleep = (ms) => new Promise((r) => setTimeout(r, ms));\nconst usd = (c) => `$${c % 100 === 0 ? c / 100 : (c / 100).toFixed(2)}`;\nconst usd2 = (c) => `$${(c / 100).toFixed(2)}`;\nconst num = (n) => Number(n).toLocaleString('en-US');\nconst lum = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };\nconst inkOn = (hex) => (lum(hex) > 0.6 ? '#14112b' : '#ffffff');\nconst fmtDate = (t) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(t * 1000));\nconst STAR = '<svg class=\"star\" viewBox=\"0 0 24 24\" aria-label=\"نجمة\"><path d=\"M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3 6.1 20.6l1.3-6.6L2.5 9.4l6.6-.8z\"/></svg>';\nconst haptic = (kind) => { try { kind === 'tap' ? tg?.HapticFeedback?.impactOccurred('light') : tg?.HapticFeedback?.notificationOccurred(kind); } catch {} };\n\nlet toastTimer;\nfunction toast(msg, err = false) {\n  const el = $('#toast');\n  el.textContent = msg;\n  el.className = `show${err ? ' err' : ''}`;\n  clearTimeout(toastTimer);\n  toastTimer = setTimeout(() => (el.className = ''), 3200);\n}\n\nasync function api(path, body) {\n  const headers = { 'content-type': 'application/json', 'x-init-data': initData };\n  if (token) headers.authorization = `Bearer ${token}`;\n  const r = await fetch(`/api${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });\n  const j = await r.json().catch(() => ({}));\n  if (!r.ok) throw Object.assign(new Error(j.error || 'تعذّر إكمال الطلب. حاول مرة أخرى'), { status: r.status });\n  return j;\n}\n\nconst GUEST = { me: { balance: 0, name: '' }, orders: [], ledger: [] };\nasync function refresh() {\n  try {\n    if (!isTg && !token) Object.assign(state, await api('/catalog'), GUEST, { loaded: true, guest: true });\n    else Object.assign(state, await api('/state'), { loaded: true, guest: false });\n  } catch (e) {\n    if (!isTg && token && e.status === 401) { token = ''; tokenStore.set(''); return refresh(); }\n    throw e;\n  }\n  render();\n}\n\nconst product = (id) => state.products.find((p) => p.id === id);\nconst STATUS = {\n  delivered: ['تم التسليم', 'ok'], pending: ['قيد التجهيز', 'warn'], paid: ['قيد التجهيز', 'warn'],\n  awaiting: ['بانتظار الدفع', ''], refunded: ['مسترد', ''],\n};\nconst pill = (s) => { const [t, c] = STATUS[s] || [s, '']; return `<span class=\"pill ${c}\">${t}</span>`; };\nconst glyph = (p, sm) => `<span class=\"glyph${sm ? ' sm' : ''}\" style=\"--c:${p.color};--ink:${inkOn(p.color)}\">${esc(p.glyph)}</span>`;\n\n/* ───────── الشاشات ───────── */\nfunction render() {\n  document.querySelectorAll('.dock-btn').forEach((b) => {\n    if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');\n  });\n  if (!state.loaded) { view.innerHTML = '<div class=\"skeleton\"></div>'; return; }\n  if (state.needLogin) { view.innerHTML = authView(); return; }\n  view.innerHTML = {\n    store: storeView,\n    wallet: () => `<div class=\"narrow\">${walletView()}</div>`,\n    orders: () => `<div class=\"narrow\">${ordersView()}</div>`,\n  }[state.tab]();\n  if (state.sheet) renderSheet();\n}\n\nfunction authView() {\n  const signup = state.auth.mode === 'signup';\n  return `<div class=\"narrow auth\">\n    <h1>${signup ? 'أنشئ حسابك' : 'أهلًا بعودتك'}</h1>\n    <p class=\"muted\">${esc(state.authNote) || (signup ? 'حساب واحد لمحفظتك وطلباتك واشتراكاتك.' : 'سجّل الدخول لتتابع محفظتك وطلباتك.')}</p>\n    <form id=\"authform\" class=\"form\" novalidate>\n      ${signup ? '<label class=\"field\"><span>الاسم</span><input name=\"name\" autocomplete=\"name\" maxlength=\"40\"></label>' : ''}\n      <label class=\"field\"><span>البريد الإلكتروني</span><input name=\"email\" type=\"email\" inputmode=\"email\" autocomplete=\"email\" dir=\"ltr\" required></label>\n      <label class=\"field\"><span>كلمة المرور</span><input name=\"password\" type=\"password\" autocomplete=\"${signup ? 'new-password' : 'current-password'}\" dir=\"ltr\" required minlength=\"8\"></label>\n      ${signup ? '<p class=\"note\">8 أحرف على الأقل. لا نستطيع استعادة كلمة المرور، فاحفظها في مكان آمن.</p>' : ''}\n      <div id=\"autherr\" class=\"err\" role=\"alert\"></div>\n      <button class=\"btn\" type=\"submit\">${signup ? 'إنشاء الحساب' : 'تسجيل الدخول'}</button>\n    </form>\n    <button class=\"linkbtn\" data-act=\"authmode\">${signup ? 'عندك حساب؟ سجّل الدخول' : 'ما عندك حساب؟ أنشئ حسابًا'}</button>\n    <button class=\"linkbtn muted-link\" data-act=\"authback\">رجوع إلى المتجر</button>\n  </div>`;\n}\n\nfunction tiles() {\n  const q = state.q.trim().toLowerCase();\n  const list = state.products.filter((p) => (state.cat === 'all' || p.cat === state.cat) && (!q || p.name.toLowerCase().includes(q)));\n  if (!list.length) return '<div class=\"empty\"><p>ما لقينا خدمة بهذا الاسم</p></div>';\n  return `<div class=\"grid\">${list.map((p) => {\n    const avail = p.plans.filter((x) => x.available);\n    const from = avail.length ? Math.min(...avail.map((x) => x.price)) : null;\n    return `<button class=\"tile\" data-act=\"open\" data-id=\"${p.id}\" data-off=\"${from === null ? 1 : 0}\">\n      ${glyph(p)}<span class=\"tname\">${esc(p.name)}</span>\n      <span class=\"tfrom\">${from === null ? 'غير متوفر' : `من <bdi>${usd(from)}</bdi>`}</span></button>`;\n  }).join('')}</div>`;\n}\n\nfunction storeView() {\n  const cats = [{ key: 'all', name: 'الكل' }, ...state.categories];\n  return `\n    <div class=\"head\">\n      <h1>المتجر</h1>\n      ${state.guest\n        ? '<button class=\"chip-wallet guest-chip\" data-act=\"login\">دخول</button>'\n        : `<button class=\"chip-wallet\" data-act=\"tab\" data-tab=\"wallet\" aria-label=\"رصيد المحفظة\"><bdi>${usd2(state.me.balance)}</bdi></button>`}\n    </div>\n    <label class=\"search\">\n      <svg viewBox=\"0 0 24 24\"><circle cx=\"11\" cy=\"11\" r=\"6.5\"/><path d=\"M20 20l-4-4\"/></svg>\n      <input id=\"q\" type=\"search\" placeholder=\"ابحث عن خدمة\" value=\"${esc(state.q)}\" autocomplete=\"off\">\n    </label>\n    <div class=\"cats\" role=\"group\" aria-label=\"التصنيفات\">\n      ${cats.map((c) => `<button class=\"cat\" data-act=\"cat\" data-key=\"${c.key}\" aria-pressed=\"${state.cat === c.key}\">${c.name}</button>`).join('')}\n    </div>\n    <div id=\"grid\">${tiles()}</div>`;\n}\n\nfunction walletView() {\n  const b = state.me.balance;\n  const { starsPerUsd, topups } = state.config;\n  const sel = topups.find((t) => t.usd === state.topup) || topups[0];\n  return `\n    <div class=\"head\"><h1>المحفظة</h1></div>\n    <div class=\"pass wallet\">\n      <div class=\"pass-top\">\n        <div class=\"label\">رصيدك</div>\n        <div class=\"balance\">${usd2(b)}</div>\n      </div>\n      <div class=\"pass-bot\">\n        <div class=\"rate\">${isTg ? `<span><bdi>$1</bdi> = <bdi>${num(starsPerUsd)}</bdi> ${STAR}</span>` : '<span>دفع آمن عبر Sifalo Pay</span>'}<span>رصيدك فوري</span></div>\n      </div>\n    </div>\n\n    <h2>اشحن المحفظة</h2>\n    <div class=\"packs\" role=\"radiogroup\" aria-label=\"مبلغ الشحن\">\n      ${topups.map((t) => `<button class=\"pack\" role=\"radio\" data-act=\"pack\" data-usd=\"${t.usd}\" aria-checked=\"${t.usd === sel.usd}\">\n        <b>$${t.usd}</b>${isTg ? `<span class=\"muted small\"><bdi>${num(t.stars)}</bdi> ${STAR}</span>` : ''}</button>`).join('')}\n    </div>\n    <div class=\"pay-wrap\">\n      <button class=\"btn\" data-act=\"${isTg ? 'topup' : 'webtopup'}\" ${state.busy ? 'disabled' : ''}>\n        ${state.busy ? '<span class=\"spin\"></span>' : isTg ? `اشحن <bdi>$${sel.usd}</bdi> مقابل <bdi>${num(sel.stars)}</bdi> ${STAR}` : `اشحن <bdi>$${sel.usd}</bdi> الآن`}\n      </button>\n    </div>\n\n    <h2>آخر العمليات</h2>\n    ${state.ledger.length ? `<div class=\"rows\">${state.ledger.map((l) => `\n      <div class=\"row\"><div class=\"grow\"><div class=\"t\">${esc(l.note)}</div><div class=\"muted small\">${fmtDate(l.created)}</div></div>\n      <div class=\"amt ${l.delta > 0 ? 'in' : ''}\">${l.delta > 0 ? '+' : '−'}${usd2(Math.abs(l.delta))}</div></div>`).join('')}</div>`\n      : '<p class=\"muted\">ما فيه عمليات بعد. اشحن محفظتك وابدأ الشراء.</p>'}\n    ${isTg ? '' : '<p class=\"note\" style=\"margin-top:14px\">تدفع من محافظ الجوال أو بالبطاقة في صفحة Sifalo Pay، ثم يعود رصيدك فورًا.</p><div class=\"gap\"></div><button class=\"btn ghost\" data-act=\"logout\">تسجيل الخروج</button>'}`;\n}\n\nfunction ordersView() {\n  if (!state.orders.length) {\n    return `<div class=\"head\"><h1>طلباتي</h1></div>\n      <div class=\"empty\"><p>ما عندك طلبات بعد</p><button class=\"btn sm\" data-act=\"tab\" data-tab=\"store\" style=\"margin:auto\">تصفّح المتجر</button></div>`;\n  }\n  return `<div class=\"head\"><h1>طلباتي</h1></div>${state.orders.map((o) => `\n    <button class=\"order-row row\" data-act=\"order\" data-id=\"${o.id}\">\n      ${glyph(o, true)}\n      <div class=\"grow\"><div class=\"t\" dir=\"ltr\" style=\"text-align:right;unicode-bidi:plaintext\">${esc(o.product)}</div>\n      <div class=\"muted small\">${esc(o.plan)} — ${fmtDate(o.created)}</div></div>\n      ${pill(o.status)}\n    </button>`).join('')}`;\n}\n\n/* ───────── اللوح السفلي ───────── */\nfunction openSheet(s) { state.sheet = s; renderSheet(); try { tg?.BackButton?.show(); } catch {} haptic('tap'); }\nfunction closeSheet() { state.sheet = null; sheetRoot.innerHTML = ''; try { tg?.BackButton?.hide(); } catch {} }\n\nfunction renderSheet() {\n  const s = state.sheet;\n  if (!s) return;\n  sheetRoot.innerHTML = `<div class=\"scrim\" data-act=\"close\"></div><section class=\"sheet\" role=\"dialog\" aria-modal=\"true\"><div class=\"grab\"></div>${s.type === 'product' ? productSheet(s) : orderSheet(s)}</section>`;\n}\n\nfunction productSheet(s) {\n  const p = product(s.pid);\n  const plan = p.plans.find((x) => x.id === s.planId);\n  const short = plan && state.me.balance < plan.price;\n  const label = !plan ? 'اختر الباقة'\n    : s.method === 'wallet' ? `ادفع <bdi>${usd2(plan.price)}</bdi> من المحفظة`\n      : `ادفع <bdi>${num(plan.stars)}</bdi> ${STAR} بالنجوم`;\n  return `\n    <div class=\"sheet-head\">${glyph(p)}<h3>${esc(p.name)}</h3></div>\n    <p class=\"desc\">${esc(p.desc)}</p>\n    <div class=\"plans\" role=\"radiogroup\" aria-label=\"الباقة\">\n      ${p.plans.map((x) => `<button class=\"plan\" role=\"radio\" data-act=\"plan\" data-id=\"${x.id}\" aria-checked=\"${x.id === s.planId}\" aria-disabled=\"${!x.available}\">\n        <span>${esc(x.label)}${x.available ? '' : ' <span class=\"muted small\">نفدت الكمية</span>'}</span>\n        <span class=\"p\"><b>${usd(x.price)}</b>${isTg ? `<br><span class=\"muted small\"><bdi>${num(x.stars)}</bdi> ${STAR}</span>` : ''}</span></button>`).join('')}\n    </div>\n    ${state.guest ? '<div class=\"sec\">أنشئ حسابك في خطوة واحدة عند الشراء</div>' : isTg ? `<div class=\"sec\">طريقة الدفع</div>\n    <div class=\"methods\" role=\"radiogroup\" aria-label=\"طريقة الدفع\">\n      <button class=\"method\" role=\"radio\" data-act=\"method\" data-m=\"wallet\" aria-checked=\"${s.method === 'wallet'}\">المحفظة\n        <span class=\"s ${short ? 'low' : ''}\">${short ? 'الرصيد لا يكفي' : `رصيدك <bdi>${usd2(state.me.balance)}</bdi>`}</span></button>\n      <button class=\"method\" role=\"radio\" data-act=\"method\" data-m=\"stars\" aria-checked=\"${s.method === 'stars'}\">نجوم تيليجرام\n        <span class=\"s\">${STAR} دفع مباشر</span></button>\n    </div>` : `<div class=\"sec\">الدفع من رصيد محفظتك: <bdi>${usd2(state.me.balance)}</bdi></div>`}\n    <div class=\"gap\"></div>\n    ${state.guest ? `<button class=\"btn\" data-act=\"login-buy\" ${plan ? '' : 'disabled'}>سجّل الدخول لإتمام الشراء</button>` : plan && s.method === 'wallet' && short\n      ? `<button class=\"btn\" data-act=\"goto-topup\">اشحن المحفظة</button>${isTg ? '<div class=\"gap\"></div><p class=\"note\" style=\"text-align:center\">أو اختر الدفع بالنجوم</p>' : ''}`\n      : `<button class=\"btn\" data-act=\"buy\" ${!plan || s.busy ? 'disabled' : ''}>${s.busy ? '<span class=\"spin\"></span>' : label}</button>`}`;\n}\n\nfunction orderSheet(s) {\n  const o = state.orders.find((x) => x.id === s.id);\n  if (!o) return '<p class=\"note\">الطلب غير موجود</p>';\n  const body = o.status === 'delivered'\n    ? `<div class=\"code\"><pre id=\"code\">${esc(o.delivery)}</pre><button class=\"btn ghost sm\" data-act=\"copy\">نسخ</button></div>`\n    : o.status === 'refunded' ? '<p class=\"note\">تم استرداد قيمة هذا الطلب.</p>'\n      : o.status === 'awaiting' ? '<p class=\"note\">لم يكتمل الدفع بعد. إذا دفعت للتو فانتظر لحظات.</p>'\n        : '<p class=\"note\">نجهّز اشتراكك الآن. سيصلك إشعار في البوت وتجده هنا فور التسليم.</p>';\n  return `\n    <div class=\"pass order\" style=\"--c:${o.color};--ink:${inkOn(o.color)}\">\n      <div class=\"pass-top\">\n        ${glyph(o, true)}\n        <div><div class=\"nm\">${esc(o.product)}</div><div class=\"pl\">${esc(o.plan)}</div></div>\n      </div>\n      <div class=\"pass-bot\">\n        <div class=\"rate\" style=\"margin-bottom:12px\"><span>طلب <bdi>#${o.id}</bdi></span>${pill(o.status)}</div>\n        ${body}\n      </div>\n    </div>\n    ${state.config.support ? `<p class=\"note\" style=\"margin-top:14px;text-align:center\">تحتاج مساعدة؟ راسل @${esc(state.config.support)}</p>` : ''}`;\n}\n\n/* ───────── الدفع ───────── */\nfunction payInvoice(link) {\n  if (link.startsWith('dev:')) { // وضع التجربة المحلي\n    const [, kind, id, stars] = link.split(':');\n    const payload = kind === 't' ? `t:${id}:${stars / state.config.starsPerUsd}` : `${kind}:${id}`;\n    return api('/dev/pay', { payload, stars: Number(stars) }).then(() => 'paid');\n  }\n  if (!tg?.openInvoice) return Promise.reject(new Error('افتح المتجر من داخل تيليجرام للدفع بالنجوم'));\n  return new Promise((resolve) => tg.openInvoice(link, resolve));\n}\n\nasync function waitFor(check, tries = 12) {\n  for (let i = 0; i < tries; i++) { await refresh(); if (check()) return true; await sleep(1000); }\n  return false;\n}\n\nasync function doBuy() {\n  const s = state.sheet;\n  if (!s || s.busy || !s.planId) return;\n  s.busy = true; renderSheet();\n  try {\n    const r = await api('/buy', { plan_id: s.planId, method: s.method });\n    if (s.method === 'stars') {\n      const status = await payInvoice(r.invoice);\n      if (status !== 'paid') { s.busy = false; renderSheet(); if (status !== 'cancelled') toast('لم يكتمل الدفع. لم يُخصم شيء', true); return; }\n      toast('جارٍ تأكيد الدفع…');\n      await waitFor(() => state.orders.find((o) => o.id === r.order_id)?.status !== 'awaiting');\n    } else {\n      await refresh();\n    }\n    haptic('success');\n    openSheet({ type: 'order', id: r.order_id });\n  } catch (e) {\n    haptic('error');\n    toast(e.message, true);\n    if (state.sheet === s) { s.busy = false; renderSheet(); }\n  }\n}\n\nasync function doTopup() {\n  if (state.busy) return;\n  const t = state.config.topups.find((x) => x.usd === state.topup);\n  state.busy = true; render();\n  try {\n    const before = state.me.balance;\n    const { invoice } = await api('/topup', { usd: t.usd });\n    const status = await payInvoice(invoice);\n    if (status === 'paid') {\n      toast('جارٍ تأكيد الدفع…');\n      const ok = await waitFor(() => state.me.balance > before);\n      haptic('success');\n      toast(ok ? `تمت إضافة $${t.usd} إلى محفظتك` : 'تم الدفع وسيظهر الرصيد خلال لحظات');\n    } else if (status !== 'cancelled') {\n      toast('لم يكتمل الدفع. لم يُخصم شيء', true);\n    }\n  } catch (e) {\n    haptic('error'); toast(e.message, true);\n  } finally {\n    state.busy = false; render();\n  }\n}\n\nasync function doWebTopup() {\n  if (state.busy) return;\n  state.busy = true; render();\n  try {\n    const r = await api('/web/topup', { usd: state.topup });\n    location.href = r.url;\n  } catch (e) {\n    toast(e.message, true);\n    state.busy = false; render();\n  }\n}\n\nasync function handleReturn() {\n  const ref = new URLSearchParams(location.search).get('topup');\n  if (!ref || state.needLogin) return;\n  if (state.guest) { state.needLogin = true; state.auth.mode = 'login'; state.authNote = 'سجّل الدخول لنؤكد شحنتك.'; render(); return; }\n  state.tab = 'wallet';\n  try {\n    const r = await api('/web/topup/check', { ref });\n    history.replaceState(null, '', location.pathname);\n    if (r.status === 'paid') { haptic('success'); toast(`تمت إضافة $${r.cents / 100} إلى محفظتك`); }\n    else toast('لم نستلم الدفع بعد. إن كنت دفعت فسيظهر الرصيد خلال دقائق');\n    await refresh();\n  } catch (e) { toast(e.message, true); }\n}\n\nfunction logout() {\n  api('/web/logout', {}).catch(() => {});\n  token = ''; tokenStore.set('');\n  closeSheet(); state.tab = 'store'; state.needLogin = false; Object.assign(state, GUEST, { guest: true }); render();\n}\n\n/* ───────── الأحداث ───────── */\ndocument.addEventListener('click', (e) => {\n  const el = e.target.closest('[data-act]');\n  if (!el) return;\n  const d = el.dataset;\n  switch (d.act) {\n    case 'tab':\n      closeSheet(); state.tab = d.tab; haptic('tap');\n      state.needLogin = state.guest && d.tab !== 'store';\n      if (state.needLogin) state.authNote = d.tab === 'wallet' ? 'سجّل الدخول لتفتح محفظتك وتشحنها.' : 'سجّل الدخول لتتابع طلباتك.';\n      render(); window.scrollTo(0, 0); break;\n    case 'login': state.needLogin = true; state.authNote = ''; state.auth.mode = 'login'; render(); break;\n    case 'login-buy': {\n      const s = state.sheet;\n      state.afterAuth = { pid: s.pid, planId: s.planId };\n      closeSheet(); state.needLogin = true; state.auth.mode = 'signup';\n      state.authNote = 'أنشئ حسابك أو سجّل الدخول لتكمل شراءك. لن تخسر اختيارك.';\n      render(); window.scrollTo(0, 0); break;\n    }\n    case 'authback': state.needLogin = false; state.afterAuth = null; state.authNote = ''; state.tab = 'store'; render(); break;\n    case 'cat': state.cat = d.key; haptic('tap'); render(); break;\n    case 'open': {\n      const p = product(Number(d.id));\n      const first = p.plans.find((x) => x.available);\n      if (!first) { toast('هذه الخدمة غير متوفرة حاليًا', true); break; }\n      openSheet({ type: 'product', pid: p.id, planId: first.id, method: !isTg || state.me.balance >= first.price ? 'wallet' : 'stars', busy: false });\n      break;\n    }\n    case 'plan': {\n      const s = state.sheet;\n      const plan = product(s.pid).plans.find((x) => x.id === Number(d.id));\n      if (!plan.available) break;\n      s.planId = plan.id; haptic('tap'); renderSheet(); break;\n    }\n    case 'method': state.sheet.method = d.m; haptic('tap'); renderSheet(); break;\n    case 'buy': doBuy(); break;\n    case 'goto-topup': closeSheet(); state.tab = 'wallet'; state.needLogin = false; render(); window.scrollTo(0, 0); break;\n    case 'order': openSheet({ type: 'order', id: Number(d.id) }); break;\n    case 'pack': state.topup = Number(d.usd); haptic('tap'); render(); break;\n    case 'topup': doTopup(); break;\n    case 'authmode': state.auth.mode = state.auth.mode === 'login' ? 'signup' : 'login'; render(); break;\n    case 'webtopup': doWebTopup(); break;\n    case 'logout': logout(); break;\n    case 'close': closeSheet(); break;\n    case 'copy': {\n      const text = $('#code')?.textContent || '';\n      (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => { toast('تم النسخ'); haptic('success'); }).catch(() => {\n        const r = document.createRange(); r.selectNodeContents($('#code')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('حدّد النص وانسخه');\n      });\n      break;\n    }\n  }\n});\n\ndocument.addEventListener('submit', async (e) => {\n  if (e.target.id !== 'authform') return;\n  e.preventDefault();\n  const f = new FormData(e.target);\n  const btn = e.target.querySelector('button[type=submit]');\n  const err = $('#autherr');\n  btn.disabled = true; err.textContent = '';\n  try {\n    const r = await api(state.auth.mode === 'signup' ? '/web/signup' : '/web/login', {\n      email: f.get('email'), password: f.get('password'), name: f.get('name') || '',\n    });\n    token = r.token; tokenStore.set(token);\n    const resume = state.afterAuth;\n    state.needLogin = false; state.authNote = ''; state.afterAuth = null; state.loaded = false; render();\n    await refresh();\n    if (resume) { state.tab = 'store'; render(); openSheet({ type: 'product', pid: resume.pid, planId: resume.planId, method: 'wallet', busy: false }); }\n    handleReturn();\n  } catch (e2) {\n    err.textContent = e2.message; btn.disabled = false;\n  }\n});\n\ndocument.addEventListener('input', (e) => {\n  if (e.target.id === 'q') { state.q = e.target.value; $('#grid').innerHTML = tiles(); }\n});\n\n/* ───────── البدء ───────── */\ntry {\n  tg?.ready(); tg?.expand();\n  tg?.setHeaderColor?.('#141129'); tg?.setBackgroundColor?.('#141129'); tg?.setBottomBarColor?.('#141129');\n  tg?.disableVerticalSwipes?.();\n  tg?.BackButton?.onClick(closeSheet);\n} catch {}\n\nwindow.addEventListener('pageshow', (e) => { if (e.persisted && state.busy) { state.busy = false; render(); } });\nsetInterval(() => {\n  if (document.hidden || !state.loaded || state.needLogin || state.guest || state.tab !== 'orders') return;\n  if (state.orders.some((o) => o.status === 'pending' || o.status === 'paid')) refresh().catch(() => {});\n}, 15000);\n\nrender();\nrefresh().then(handleReturn).catch((e) => {\n  view.innerHTML = `<div class=\"empty\"><p>${esc(e.message)}</p><button class=\"btn sm\" style=\"margin:auto\" onclick=\"location.reload()\">حاول مرة أخرى</button></div>`;\n});\n"},"/admin.html":{"type":"text/html; charset=utf-8","body":"<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n  <meta name=\"robots\" content=\"noindex,nofollow\">\n  <meta name=\"theme-color\" content=\"#141129\">\n  <title>إدارة المتجر</title>\n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n  <link href=\"https://fonts.googleapis.com/css2?family=Readex+Pro:wght@300..700&display=swap\" rel=\"stylesheet\">\n  <link rel=\"stylesheet\" href=\"/app.css\">\n  <style>\n    body { padding-bottom: 48px; }\n    #adm { max-width: 980px; margin: 0 auto; padding: 18px 16px 0; }\n    .bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }\n    .bar h1 { font-size: 22px; }\n    .tabs { display: flex; gap: 8px; overflow-x: auto; margin: 0 -16px 18px; padding: 0 16px; scrollbar-width: none; }\n    .tabs::-webkit-scrollbar { display: none; }\n    .tabs .cat { position: relative; }\n    .badge { display: inline-block; min-width: 20px; height: 20px; padding: 0 6px; margin-inline-start: 6px; border-radius: 999px; background: var(--star); color: #3a2a00; font-size: 12px; line-height: 20px; text-align: center; font-weight: 600; }\n    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }\n    @media (min-width: 720px) { .stats { grid-template-columns: repeat(4, 1fr); } }\n    .stat { background: var(--surface); border-radius: 18px; padding: 14px 16px; text-align: start; display: block; width: 100%; }\n    .stat b { display: block; font-size: 24px; font-weight: 600; direction: ltr; text-align: right; font-variant-numeric: tabular-nums; }\n    .stat span { color: var(--muted); font-size: 13px; }\n    button.stat:active { transform: scale(.98); }\n    .alert { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; padding: 12px 14px; border-radius: 16px; background: rgba(255, 197, 61, .13); color: var(--star); }\n    .alert .btn { flex: none; }\n    .alert.ok { background: rgba(95, 240, 207, .1); color: var(--mint); }\n    .alert.bad { background: rgba(255, 138, 152, .12); color: var(--danger); }\n    .card { background: var(--surface); border-radius: 20px; padding: 14px 16px; }\n    .card + .card { margin-top: 10px; }\n    .card .top { display: flex; align-items: center; gap: 12px; }\n    .card .grow { flex: 1; min-width: 0; }\n    .nm { font-weight: 500; line-height: 1.4; }\n    .ltr { direction: ltr; unicode-bidi: plaintext; text-align: right; }\n    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }\n    .inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }\n    .inline.end { justify-content: flex-end; }\n    textarea, .in {\n      width: 100%; border: 0; border-radius: 14px; background: var(--surface-2); color: var(--text);\n      padding: 12px 14px; font-size: 15px; outline: 0; min-height: 46px;\n    }\n    textarea { min-height: 84px; resize: vertical; direction: ltr; text-align: left; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 14px; }\n    .in.num { direction: ltr; text-align: left; }\n    textarea:focus, .in:focus { box-shadow: 0 0 0 2px var(--mint); }\n    .in.sm { width: 110px; }\n    .in.md { flex: 1; min-width: 140px; width: auto; }\n    .btn.sm.danger { background: rgba(255, 138, 152, .16); color: var(--danger); }\n    .btn.sm.warn { background: rgba(255, 197, 61, .16); color: var(--star); }\n    .plan-row { padding: 12px 0; border-top: 1px solid var(--line); }\n    .plan-row:first-of-type { border-top: 0; }\n    .plan-row .line { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }\n    .check { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 14px; cursor: pointer; }\n    .check input { width: 18px; height: 18px; accent-color: var(--mint); }\n    .stockline { color: var(--muted); font-size: 13px; }\n    .stockline.low { color: var(--danger); }\n    details.form { margin-bottom: 14px; }\n    details.form > summary { list-style: none; cursor: pointer; }\n    details.form > summary::-webkit-details-marker { display: none; }\n    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }\n    .grid2 .full { grid-column: 1 / -1; }\n    .login { max-width: 420px; margin: 12vh auto 0; }\n    .login h1 { margin-bottom: 6px; }\n    .hint { color: var(--muted); font-size: 13px; margin: 6px 0 0; }\n    .empty-line { color: var(--muted); padding: 24px 0; text-align: center; }\n    .pill.bad { background: rgba(255, 138, 152, .15); color: var(--danger); }\n    .toprow { display: flex; align-items: center; justify-content: space-between; gap: 10px; }\n    .mt { margin-top: 12px; }\n  </style>\n</head>\n<body>\n  <div id=\"adm\"></div>\n  <div id=\"toast\" role=\"status\"></div>\n<script>\n'use strict';\nconst $ = (s) => document.querySelector(s);\nconst root = $('#adm');\nconst esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[c]);\nconst usd = (c) => `$${(c / 100).toFixed(2)}`;\nconst fmtDate = (t) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(t * 1000));\nconst store = {\n  get() { try { return localStorage.getItem('adm') || ''; } catch { return ''; } },\n  set(v) { try { v ? localStorage.setItem('adm', v) : localStorage.removeItem('adm'); } catch {} },\n};\nlet token = store.get();\nconst S = { tab: 'overview', ov: null, orders: [], ostatus: 'pending', cat: null, users: [], q: '', topups: [], armed: null };\n\nlet tt;\nfunction toast(msg, err) {\n  const el = $('#toast');\n  el.textContent = msg; el.className = 'show' + (err ? ' err' : '');\n  clearTimeout(tt); tt = setTimeout(() => { el.className = ''; }, 3200);\n}\n\nasync function api(path, body) {\n  const h = { 'content-type': 'application/json' };\n  if (token) h.authorization = 'Bearer ' + token;\n  const r = await fetch('/api/admin' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });\n  const j = await r.json().catch(() => ({}));\n  if (!r.ok) {\n    if (r.status === 401 && token) { token = ''; store.set(''); renderLogin('انتهت الجلسة. سجّل الدخول من جديد'); }\n    throw new Error(j.error || 'تعذّر إكمال الطلب');\n  }\n  return j;\n}\n\n/* زر بخطوتين بدل confirm() */\nfunction armed(id) { return S.armed === id; }\nfunction arm(id) { S.armed = id; setTimeout(() => { if (S.armed === id) { S.armed = null; show(); } }, 3500); show(); }\n\n/* ───────── تسجيل الدخول ───────── */\nfunction renderLogin(note) {\n  root.innerHTML = `<div class=\"login\">\n    <h1>إدارة المتجر</h1>\n    <p class=\"muted\">${esc(note || 'اكتب كلمة سر الإدارة.')}</p>\n    <form id=\"lf\" class=\"form\" novalidate>\n      <label class=\"field\"><span>كلمة السر</span><input id=\"pw\" type=\"password\" autocomplete=\"current-password\" dir=\"ltr\" required></label>\n      <div class=\"err\" id=\"le\" role=\"alert\"></div>\n      <button class=\"btn\" type=\"submit\">دخول</button>\n    </form></div>`;\n  $('#lf').addEventListener('submit', async (e) => {\n    e.preventDefault();\n    const b = e.target.querySelector('button'); b.disabled = true; $('#le').textContent = '';\n    try {\n      const r = await api('/login', { password: $('#pw').value });\n      token = r.token; store.set(token); start();\n    } catch (er) { $('#le').textContent = er.message; b.disabled = false; }\n  });\n}\n\n/* ───────── الإطار ───────── */\nconst TABS = [['overview', 'نظرة عامة'], ['orders', 'الطلبات'], ['products', 'المنتجات'], ['users', 'العملاء'], ['topups', 'الشحنات']];\nfunction shell(inner) {\n  const pend = S.ov?.orders.pending || 0;\n  return `<div class=\"bar\"><h1>إدارة المتجر</h1><button class=\"btn ghost sm\" data-act=\"logout\">خروج</button></div>\n    <div class=\"tabs\" role=\"tablist\">${TABS.map(([k, n]) => `<button class=\"cat\" role=\"tab\" data-act=\"tab\" data-t=\"${k}\" aria-pressed=\"${S.tab === k}\">${n}${k === 'orders' && pend ? `<span class=\"badge\">${pend}</span>` : ''}</button>`).join('')}</div>\n    <div id=\"content\">${inner}</div>`;\n}\n\nfunction show() {\n  const views = { overview: vOverview, orders: vOrders, products: vProducts, users: vUsers, topups: vTopups };\n  const keepScroll = window.scrollY;\n  const focus = document.activeElement?.id;\n  const saved = [...root.querySelectorAll('input[id],textarea[id],select[id]')].map((el) => [el.id, el.type === 'checkbox' ? el.checked : el.value]);\n  const open = [...root.querySelectorAll('details[open]')].map((d) => d.querySelector('[id]')?.id).filter(Boolean);\n  root.innerHTML = shell(views[S.tab]());\n  for (const [id, v] of saved) {\n    const el = document.getElementById(id);\n    if (!el || id === 'uq') continue;\n    if (el.type === 'checkbox') el.checked = v; else if (v !== '' ) el.value = v;\n  }\n  for (const id of open) { const d = document.getElementById(id)?.closest('details'); if (d) d.open = true; }\n  window.scrollTo(0, keepScroll);\n  if (focus) $('#' + focus)?.focus();\n}\n\n/* ───────── نظرة عامة ───────── */\nfunction vOverview() {\n  const o = S.ov;\n  if (!o) return '<div class=\"skeleton\"></div>';\n  const stat = (n, label, act) => `<${act ? 'button' : 'div'} class=\"stat\" ${act ? `data-act=\"${act}\"` : ''}><b>${n}</b><span>${label}</span></${act ? 'button' : 'div'}>`;\n  return `\n    <div class=\"stats\">\n      ${stat(usd(o.salesTodayCents), 'مبيعات آخر 24 ساعة')}\n      ${stat(usd(o.salesCents), 'إجمالي المبيعات')}\n      ${stat(o.orders.pending, 'طلبات تنتظر التسليم', 'go-pending')}\n      ${stat(usd(o.walletsCents), 'أرصدة العملاء')}\n      ${stat(usd(o.topupsCents), 'شحنات Sifalo')}\n      ${stat(o.stars, 'نجوم مستلمة')}\n      ${stat(o.users, 'العملاء')}\n      ${stat(o.orders.delivered, 'طلبات مسلّمة')}\n    </div>\n    ${o.orders.pending ? `<div class=\"alert\"><span>${o.orders.pending} طلب بانتظار تسليمك</span><button class=\"btn sm\" data-act=\"go-pending\">افتح الطلبات</button></div>` : ''}\n    ${o.pendingTopups ? `<div class=\"alert\"><span>${o.pendingTopups} شحنة لم يتأكد دفعها بعد</span><button class=\"btn sm\" data-act=\"go-topups\">راجعها</button></div>` : ''}\n    <div class=\"alert ${o.sifalo ? 'ok' : 'bad'}\"><span>${o.sifalo ? `Sifalo Pay مفعّل${o.staging ? ' (وضع التجربة)' : ''}` : 'Sifalo Pay غير مفعّل: أضف SIFALO_API_USER وSIFALO_API_KEY في Cloudflare'}</span></div>\n    ${o.sifalo ? '<div class=\"card\"><button class=\"btn sm\" data-act=\"sifalotest\">فحص اتصال Sifalo</button><pre id=\"stest\" class=\"ltr\" style=\"white-space:pre-wrap;margin:10px 0 0;font-size:12px;direction:ltr;text-align:left\"></pre></div>' : ''}\n    <div class=\"alert ${o.telegram ? 'ok' : ''}\"><span>${o.telegram ? 'بوت تيليجرام مرتبط' : 'بوت تيليجرام غير مضبوط (اختياري)'}</span></div>\n    ${o.lowStock.length ? `<h2>مخزون منخفض</h2>${o.lowStock.map((l) => `<div class=\"card\"><div class=\"toprow\"><span class=\"nm ltr\">${esc(l.name)} — ${esc(l.label)}</span><span class=\"pill ${l.stock ? 'warn' : 'bad'}\">${l.stock ? `متبقي ${l.stock}` : 'نفد'}</span></div></div>`).join('')}` : ''}`;\n}\n\n/* ───────── الطلبات ───────── */\nconst ST = { pending: ['قيد التجهيز', 'warn'], delivered: ['تم التسليم', 'ok'], refunded: ['مسترد', ''] };\nfunction vOrders() {\n  const fl = [['pending', 'قيد التجهيز'], ['delivered', 'تم التسليم'], ['refunded', 'مسترد'], ['', 'الكل']];\n  const list = S.orders.map((o) => {\n    const [t, c] = ST[o.status] || [o.status, ''];\n    return `<div class=\"card\">\n      <div class=\"top\"><div class=\"grow\"><div class=\"nm ltr\">${esc(o.product)}</div><div class=\"muted small\">${esc(o.plan)} — <bdi>${usd(o.price)}</bdi> — طلب <bdi>#${o.id}</bdi></div></div><span class=\"pill ${c}\">${t}</span></div>\n      <div class=\"muted small mt ltr\">${esc(o.who)} · ${fmtDate(o.created)} · ${o.method === 'stars' ? 'نجوم' : 'محفظة'}</div>\n      ${o.status === 'pending' ? `\n        <label class=\"field mt\"><span>بيانات الاشتراك التي تصل العميل</span><textarea id=\"dl${o.id}\" placeholder=\"email:password أو كود التفعيل\"></textarea></label>\n        <div class=\"inline end\">\n          <button class=\"btn sm danger\" data-act=\"refund\" data-id=\"${o.id}\">${armed('r' + o.id) ? 'اضغط للتأكيد' : 'استرداد'}</button>\n          <button class=\"btn sm\" data-act=\"deliver\" data-id=\"${o.id}\">تسليم</button>\n        </div>` : ''}\n      ${o.status === 'delivered' ? `\n        <div class=\"code mt\"><pre>${esc(o.delivery)}</pre></div>\n        <div class=\"inline end\"><button class=\"btn sm danger\" data-act=\"refund\" data-id=\"${o.id}\">${armed('r' + o.id) ? 'اضغط للتأكيد' : 'استرداد للمحفظة'}</button></div>` : ''}\n    </div>`;\n  }).join('');\n  return `<div class=\"chips\">${fl.map(([k, n]) => `<button class=\"cat\" data-act=\"ofilter\" data-s=\"${k}\" aria-pressed=\"${S.ostatus === k}\">${n}</button>`).join('')}</div>\n    ${list || '<div class=\"empty-line\">لا توجد طلبات هنا</div>'}`;\n}\n\n/* ───────── المنتجات ───────── */\nfunction vProducts() {\n  const c = S.cat;\n  if (!c) return '<div class=\"skeleton\"></div>';\n  const add = `<details class=\"form\"><summary><span class=\"btn ghost sm\" style=\"display:inline-flex\">إضافة منتج جديد</span></summary>\n    <div class=\"card mt\"><div class=\"grid2\">\n      <input class=\"in\" id=\"np-name\" placeholder=\"اسم المنتج (مثل Netflix)\" dir=\"ltr\">\n      <select class=\"in\" id=\"np-cat\">${c.categories.map((k) => `<option value=\"${k.key}\">${esc(k.name)}</option>`).join('')}</select>\n      <input class=\"in\" id=\"np-color\" placeholder=\"اللون #FF5577\" dir=\"ltr\" value=\"#7C6CFF\">\n      <input class=\"in\" id=\"np-glyph\" placeholder=\"رمز: حرف أو حرفان\" maxlength=\"2\" dir=\"ltr\">\n      <input class=\"in full\" id=\"np-desc\" placeholder=\"وصف قصير بالعربي\">\n      <button class=\"btn full\" data-act=\"addproduct\">إضافة المنتج</button>\n    </div></div></details>`;\n  const items = c.products.map((p) => `<div class=\"card\">\n    <div class=\"top\">\n      <span class=\"glyph sm\" style=\"--c:${esc(p.color)};--ink:#14112b\">${esc(p.glyph)}</span>\n      <div class=\"grow\"><div class=\"nm ltr\">${esc(p.name)}</div><div class=\"muted small\">${esc(p.desc)}</div></div>\n      <button class=\"btn sm ${p.active ? 'ghost' : 'warn'}\" data-act=\"ptoggle\" data-id=\"${p.id}\" data-on=\"${p.active ? 0 : 1}\">${p.active ? 'إخفاء' : 'إظهار'}</button>\n    </div>\n    <div class=\"mt\">${p.plans.map((x) => `<div class=\"plan-row\">\n      <div class=\"line\">\n        <span class=\"nm\" style=\"min-width:90px\">${esc(x.label)}</span>\n        <input class=\"in sm num\" id=\"pr${x.id}\" type=\"number\" min=\"0.01\" step=\"0.01\" inputmode=\"decimal\" value=\"${(x.price / 100).toFixed(2)}\" aria-label=\"السعر بالدولار\">\n        <label class=\"check\"><input type=\"checkbox\" id=\"mn${x.id}\" ${x.manual ? 'checked' : ''}>تسليم يدوي</label>\n        <button class=\"btn sm\" data-act=\"psave\" data-id=\"${x.id}\">حفظ</button>\n        <button class=\"btn sm ${x.active ? 'ghost' : 'warn'}\" data-act=\"plantoggle\" data-id=\"${x.id}\" data-on=\"${x.active ? 0 : 1}\">${x.active ? 'إخفاء' : 'إظهار'}</button>\n      </div>\n      <div class=\"stockline ${!x.manual && x.stock <= 2 ? 'low' : ''} mt\">المخزون: ${x.stock}${x.manual ? ' (يُباع حتى بدون مخزون)' : ''}</div>\n      <details class=\"mt\"><summary class=\"stockline\" style=\"cursor:pointer\">إضافة مخزون</summary>\n        <textarea id=\"st${x.id}\" placeholder=\"كل سطر = حساب أو كود لعميل واحد\"></textarea>\n        <div class=\"inline end\"><button class=\"btn sm\" data-act=\"addstock\" data-id=\"${x.id}\">إضافة</button></div>\n      </details>\n    </div>`).join('')}</div>\n    <details class=\"mt\"><summary class=\"stockline\" style=\"cursor:pointer\">إضافة باقة</summary>\n      <div class=\"inline\">\n        <input class=\"in md\" id=\"nl${p.id}\" placeholder=\"اسم الباقة (مثل 3 أشهر)\">\n        <input class=\"in sm num\" id=\"np${p.id}\" type=\"number\" min=\"0.01\" step=\"0.01\" inputmode=\"decimal\" placeholder=\"السعر $\">\n        <label class=\"check\"><input type=\"checkbox\" id=\"nm${p.id}\" checked>يدوي</label>\n        <button class=\"btn sm\" data-act=\"addplan\" data-id=\"${p.id}\">إضافة</button>\n      </div>\n    </details>\n  </div>`).join('');\n  return add + items;\n}\n\n/* ───────── العملاء ───────── */\nfunction vUsers() {\n  return `<input class=\"in\" id=\"uq\" type=\"search\" placeholder=\"ابحث بالبريد أو الاسم أو الرقم\" value=\"${esc(S.q)}\" autocomplete=\"off\">\n    <div class=\"mt\">${S.users.map((u) => `<div class=\"card\">\n      <div class=\"top\"><div class=\"grow\"><div class=\"nm ltr\">${esc(u.label)}</div><div class=\"muted small\">${esc(u.name)} · ${u.orders} طلب · ${fmtDate(u.created)}</div></div><b class=\"amt\">${usd(u.balance)}</b></div>\n      <details class=\"mt\"><summary class=\"stockline\" style=\"cursor:pointer\">تعديل الرصيد</summary>\n        <div class=\"inline\">\n          <input class=\"in sm num\" id=\"ca${u.id}\" type=\"number\" step=\"0.01\" inputmode=\"decimal\" placeholder=\"± بالدولار\">\n          <input class=\"in md\" id=\"cn${u.id}\" placeholder=\"ملاحظة (اختياري)\">\n          <button class=\"btn sm\" data-act=\"credit\" data-id=\"${u.id}\">طبّق</button>\n        </div>\n        <p class=\"hint\">اكتب رقمًا موجبًا للإضافة أو سالبًا للخصم.</p>\n      </details></div>`).join('') || '<div class=\"empty-line\">لا يوجد عملاء مطابقون</div>'}</div>`;\n}\n\n/* ───────── الشحنات ───────── */\nfunction vTopups() {\n  const ST2 = { paid: ['مدفوعة', 'ok'], pending: ['بانتظار التأكيد', 'warn'], failed: ['فشلت', 'bad'] };\n  return S.topups.map((t) => {\n    const [n, c] = ST2[t.status] || [t.status, ''];\n    return `<div class=\"card\">\n      <div class=\"top\"><div class=\"grow\"><div class=\"nm ltr\">${esc(t.who)}</div><div class=\"muted small\">${fmtDate(t.created)}</div></div><b class=\"amt\">${usd(t.cents)}</b><span class=\"pill ${c}\">${n}</span></div>\n      ${t.status !== 'paid' ? `<div class=\"inline end\">\n        ${t.status === 'pending' ? `<button class=\"btn sm\" data-act=\"tverify\" data-ref=\"${t.ref}\">تحقق من الدفع</button>` : ''}\n        <button class=\"btn sm warn\" data-act=\"tcredit\" data-ref=\"${t.ref}\">${armed('c' + t.ref) ? 'أكّد أنك رأيت المبلغ في Sifalo' : 'إضافة يدوية'}</button>\n      </div>` : ''}</div>`;\n  }).join('') || '<div class=\"empty-line\">لا توجد شحنات بعد</div>';\n}\n\n/* ───────── التحميل ───────── */\nasync function load(tab) {\n  try {\n    if (tab === 'overview' || !S.ov) S.ov = await api('/overview');\n    if (tab === 'orders') S.orders = (await api('/orders?status=' + S.ostatus)).orders;\n    if (tab === 'products') S.cat = await api('/catalog');\n    if (tab === 'users') S.users = (await api('/users?q=' + encodeURIComponent(S.q))).users;\n    if (tab === 'topups') S.topups = (await api('/topups')).topups;\n  } catch (e) { if (token) toast(e.message, true); }\n  show();\n}\nasync function go(tab) { S.tab = tab; S.armed = null; show(); await load(tab); window.scrollTo(0, 0); }\n\nasync function act(fn, okMsg, reload) {\n  try { await fn(); if (okMsg) toast(okMsg); S.ov = null; await load(reload || S.tab); }\n  catch (e) { toast(e.message, true); }\n}\n\ndocument.addEventListener('click', (e) => {\n  const el = e.target.closest('[data-act]');\n  if (!el) return;\n  const d = el.dataset;\n  const num = (id) => $('#' + id)?.value;\n  switch (d.act) {\n    case 'tab': go(d.t); break;\n    case 'go-pending': S.ostatus = 'pending'; go('orders'); break;\n    case 'go-topups': go('topups'); break;\n    case 'sifalotest': {\n      const el = $('#stest'); el.textContent = 'جارٍ الفحص...';\n      api('/sifalo/test', {}).then((r) => { el.textContent = (r.ok ? '✅ الاتصال يعمل، Sifalo أعطت رابط دفع' : '❌ فشل الاتصال') + `\\nالبيئة: ${r.env}\\nالخادم: ${r.host}\\nالمستخدم: ${r.user}\\nالحالة: ${r.status}\\nرد Sifalo: ${r.response}`; }).catch((e) => { el.textContent = '❌ ' + e.message; });\n      break;\n    }\n    case 'logout': api('/logout', {}).catch(() => {}); token = ''; store.set(''); renderLogin(); break;\n    case 'ofilter': S.ostatus = d.s; load('orders'); break;\n    case 'deliver': act(() => api('/deliver', { id: +d.id, text: num('dl' + d.id) }), 'تم التسليم', 'orders'); break;\n    case 'refund':\n      if (!armed('r' + d.id)) return arm('r' + d.id);\n      S.armed = null; act(() => api('/refund', { id: +d.id }), 'تم الاسترداد إلى المحفظة', 'orders'); break;\n    case 'psave': act(() => api('/plan/update', { id: +d.id, price: num('pr' + d.id), manual: $('#mn' + d.id).checked }), 'تم الحفظ', 'products'); break;\n    case 'plantoggle': act(() => api('/plan/update', { id: +d.id, active: +d.on }), 'تم', 'products'); break;\n    case 'ptoggle': act(() => api('/product/update', { id: +d.id, active: +d.on }), 'تم', 'products'); break;\n    case 'addstock': act(() => api('/stock', { plan_id: +d.id, lines: num('st' + d.id) }), 'أُضيف المخزون', 'products'); break;\n    case 'addplan': act(() => api('/plan/add', { product_id: +d.id, label: num('nl' + d.id), price: num('np' + d.id), manual: $('#nm' + d.id).checked }), 'أُضيفت الباقة', 'products'); break;\n    case 'addproduct': act(() => api('/product/add', { name: num('np-name'), cat: num('np-cat'), color: num('np-color'), glyph: num('np-glyph'), desc: num('np-desc') }), 'أُضيف المنتج، أضف له باقة الآن', 'products'); break;\n    case 'credit': act(() => api('/credit', { user_id: +d.id, amount: num('ca' + d.id), note: num('cn' + d.id) }), 'تم تعديل الرصيد', 'users'); break;\n    case 'tverify': act(async () => { const r = await api('/topup/verify', { ref: d.ref }); toast(r.status === 'paid' ? 'تأكد الدفع وأُضيف الرصيد' : 'لم يتأكد الدفع بعد في Sifalo'); }, '', 'topups'); break;\n    case 'tcredit':\n      if (!armed('c' + d.ref)) return arm('c' + d.ref);\n      S.armed = null; act(() => api('/topup/credit', { ref: d.ref }), 'أُضيف الرصيد يدويًا', 'topups'); break;\n  }\n});\n\nlet qt;\ndocument.addEventListener('input', (e) => {\n  if (e.target.id === 'uq') { S.q = e.target.value; clearTimeout(qt); qt = setTimeout(() => load('users'), 300); }\n});\n\nasync function start() {\n  if (!token) return renderLogin();\n  S.tab = 'overview'; S.ov = null; show(); await load('overview');\n}\nstart();\n</script>\n</body>\n</html>\n"}};

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
