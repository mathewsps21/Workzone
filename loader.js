/* WorkZone · carregador: login, dados e ponte com o Supabase */
(function () {
  const CFG = window.WZ_CFG || {};
  const SB_URL = CFG.url, SB_KEY = CFG.key, CDN = CFG.cdn; // CDN termina com "/"
  const BUCKET_MIDIA = 'midia', BUCKET_ANEXOS = 'anexos';
  const $ = s => document.querySelector(s);
  const tela = document.getElementById('wz-tela');

  function msg(html) { tela.querySelector('.wz-msg').innerHTML = html; }
  function botoes(lista) {
    const w = tela.querySelector('.wz-acoes'); w.textContent = '';
    lista.forEach(([t, fn, prim]) => { const b = document.createElement('button'); b.textContent = t; if (prim) b.className = 'prim'; b.onclick = fn; w.append(b); });
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rand = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join(''); };

  if (!window.supabase || !SB_URL) { msg('Não foi possível carregar o WorkZone. Recarregue a página.'); return; }
  const sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } });
  window.wzSb = sb;

  async function entrar() {
    const volta = location.origin + location.pathname;
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: volta, queryParams: { prompt: 'select_account' } } });
    if (error) msg('Não foi possível abrir o login do Google: ' + esc(error.message));
  }
  window.wzSair = async () => { await sb.auth.signOut(); location.href = location.origin + location.pathname; };

  async function iniciar() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { msg('Entre com a sua conta Google da equipe.'); botoes([['Entrar com Google', entrar, true]]); return; }
    const u = session.user, email = (u.email || '').toLowerCase();
    msg('Abrindo o WorkZone…'); botoes([]);
    const { data: mb, error: e1 } = await sb.from('membros').select('email,nome,admin').eq('email', email).maybeSingle();
    if (e1 || !mb) {
      msg('O e-mail <b>' + esc(email) + '</b> ainda não tem acesso ao WorkZone. Peça para o Gomes liberar.');
      botoes([['Entrar com outra conta', window.wzSair, true]]); return;
    }
    const md = u.user_metadata || {};
    await sb.from('perfis').upsert({ uid: u.id, nome: md.full_name || md.name || mb.nome || email, avatar_url: md.avatar_url || md.picture || null, email, atualizado: new Date().toISOString() });

    // dados da área de aprovação + mídia
    let areas = [];
    const { data: arq } = await sb.storage.from(BUCKET_MIDIA).download('dados/areas.json');
    if (arq) { try { areas = JSON.parse(await arq.text()); } catch (e) { areas = []; } }
    const { count: nDocs } = await sb.from('docs').select('id', { count: 'exact', head: true });
    if (mb.admin && (!arq || !nDocs || /[?&]importar/.test(location.search))) return telaImportar(!!arq, nDocs || 0);
    const legado = {};
    { const { data } = await sb.from('docs').select('id,data').eq('col', 'legado'); (data || []).forEach(r => legado[r.id] = r.data && r.data.nome); }
    const caminhos = [];
    areas.forEach(a => (a.posts || []).forEach(p => (p.midias || []).forEach(m => { [m.src, m.capa].forEach(s => { if (s && s.startsWith('m/')) caminhos.push(s.slice(2)); }); })));
    const assinados = {};
    for (let i = 0; i < caminhos.length; i += 200) {
      const { data } = await sb.storage.from(BUCKET_MIDIA).createSignedUrls(caminhos.slice(i, i + 200), 60 * 60 * 12);
      (data || []).forEach(d => { if (d.signedUrl) assinados[d.path] = d.signedUrl; });
    }
    areas.forEach(a => (a.posts || []).forEach(p => (p.midias || []).forEach(m => {
      if (m.src && m.src.startsWith('m/')) m.src = assinados[m.src.slice(2)] || m.src;
      if (m.capa && m.capa.startsWith('m/')) m.capa = assinados[m.capa.slice(2)] || m.capa;
    })));

    window.claude = criarPonte(u, mb, legado);
    const r = await fetch(CDN + 'app.html', { cache: 'no-store' });
    if (!r.ok) { msg('Não foi possível baixar o WorkZone. Recarregue a página.'); return; }
    let html = await r.text();
    const json = JSON.stringify(areas).replace(/<\//g, '<\\/');
    let fontes = '';
    try { const { data: fc } = await sb.storage.from(BUCKET_MIDIA).download('fontes.css'); if (fc) fontes = await fc.text(); } catch (e) { }
    html = html.split('__CDN__').join(CDN).replace('__DADOS__', () => json).replace('</head>', () => '<style>' + fontes.replace(/<\//g, '') + '</style></head>');
    document.open(); document.write(html); document.close();
  }

  // ---------- ponte: imita window.claude.use(...) sobre o Supabase ----------
  function criarPonte(u, mb, legado) {
    const cache = {}; // col -> Map(id -> data)
    const ouvintes = {}; // col -> Set(fn)
    let canal = null;
    const snap = col => {
      const m = cache[col] || new Map();
      return { docs: [...m.entries()].map(([id, data]) => ({ id, data: () => data })), metadata: { fromCache: false } };
    };
    const avisar = col => { (ouvintes[col] || []).forEach(fn => { try { fn(snap(col)); } catch (e) { console.error(e); } }); };
    function ligarCanal() {
      if (canal) return;
      canal = sb.channel('docs').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, p => {
        const row = p.new && p.new.col ? p.new : p.old; if (!row || !row.col) return;
        const m = cache[row.col]; if (!m) return;
        if (p.eventType === 'DELETE') m.delete(row.id); else m.set(row.id, p.new.data);
        avisar(row.col);
      }).subscribe();
    }
    async function carregar(col) {
      const m = new Map(); let de = 0;
      for (;;) {
        const { data, error } = await sb.from('docs').select('id,data').eq('col', col).range(de, de + 999);
        if (error) throw error;
        data.forEach(r => m.set(r.id, r.data)); if (data.length < 1000) break; de += 1000;
      }
      cache[col] = m;
    }
    const aplicarLocal = (col, id, data, del) => { const m = cache[col]; if (!m) return; if (del) m.delete(id); else m.set(id, data); avisar(col); };
    const db = {
      collection(col) {
        return {
          onSnapshot(fn, err) {
            (ouvintes[col] = ouvintes[col] || new Set()).add(fn); ligarCanal();
            if (cache[col]) setTimeout(() => fn(snap(col)), 0);
            else carregar(col).then(() => avisar(col)).catch(e => { console.error(e); err && err(e); });
            return () => ouvintes[col].delete(fn);
          },
          async add(d) {
            const id = rand(20); const { error } = await sb.from('docs').insert({ col, id, data: d }); if (error) throw error;
            aplicarLocal(col, id, d); return { id };
          },
          doc(id) { return db.doc(col + '/' + id); }
        };
      },
      doc(path) {
        const i = path.indexOf('/'); const col = path.slice(0, i), id = path.slice(i + 1);
        return {
          async set(d) { const { error } = await sb.from('docs').upsert({ col, id, data: d, updated_at: new Date().toISOString() }); if (error) throw error; aplicarLocal(col, id, d); },
          async update(patch) {
            const { error } = await sb.rpc('doc_merge', { p_col: col, p_id: id, p_patch: patch }); if (error) throw error;
            const m = cache[col]; if (m) aplicarLocal(col, id, { ...(m.get(id) || {}), ...patch });
          },
          async delete() { const { error } = await sb.from('docs').delete().eq('col', col).eq('id', id); if (error) throw error; aplicarLocal(col, id, null, true); }
        };
      }
    };
    const user = {
      id: async () => u.id,
      isOwner: async () => !!mb.admin,
      canEdit: async () => !!mb.admin,
      can: async () => true,
      me: async () => { const md = u.user_metadata || {}; return { id: u.id, name: md.full_name || md.name || mb.nome || '', email: u.email, avatarUrl: md.avatar_url || md.picture || '' }; },
      profiles: async ids => {
        const out = {}; ids.forEach(i => out[i] = { id: i, name: (legado && legado[i]) || '', avatarUrl: '' });
        const ok = ids.filter(i => /^[0-9a-f-]{36}$/i.test(i));
        if (ok.length) { const { data } = await sb.from('perfis').select('uid,nome,avatar_url').in('uid', ok); (data || []).forEach(p => out[p.uid] = { id: p.uid, name: p.nome || '', avatarUrl: p.avatar_url || '' }); }
        return out;
      }
    };
    const sinal = {}; let fila = new Set(), timer = null;
    window.blobUrl = id => {
      if (!id) return ''; const s = sinal[id]; if (s && s.exp > Date.now()) return s.url;
      fila.add(id); clearTimeout(timer); timer = setTimeout(assinarFila, 30);
      return 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
    };
    window.blobUrlAsync = async id => { const { data } = await sb.storage.from(BUCKET_ANEXOS).createSignedUrl(id, 3600); return data && data.signedUrl; };
    async function assinarFila() {
      const ids = [...fila]; fila = new Set(); if (!ids.length) return;
      const { data } = await sb.storage.from(BUCKET_ANEXOS).createSignedUrls(ids, 60 * 60 * 6);
      (data || []).forEach(d => { if (d.signedUrl) sinal[d.path] = { url: d.signedUrl, exp: Date.now() + 5.5 * 3600e3 }; });
      try { if (typeof renderPlanner === 'function') renderPlanner(); if (typeof PL !== 'undefined' && PL.aberto && typeof renderModal === 'function') renderModal(); } catch (e) { }
    }
    const assets = {
      async upload(blob, o) {
        const type = (o && o.type) || blob.type; if (blob.size > 20 * 1048576) throw { code: 'too_large', message: 'grande' };
        const id = rand(32);
        const { error } = await sb.storage.from(BUCKET_ANEXOS).upload(id, blob, { contentType: type, upsert: false });
        if (error) throw { code: /size|large/i.test(error.message) ? 'too_large' : 'upstream_error', message: error.message };
        return { id, url: await window.blobUrlAsync(id), sizeBytes: blob.size, contentType: type };
      },
      async delete(id) { await sb.storage.from(BUCKET_ANEXOS).remove([id]); return { deleted: true }; },
      async list() { return { assets: [], usage: {} }; }
    };
    const downloads = {
      async save({ filename, data }) {
        const b = data instanceof Blob ? data : new Blob([data]); const url = URL.createObjectURL(b);
        const a = document.createElement('a'); a.href = url; a.download = filename || 'arquivo'; document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
    };
    const caps = { db, user, assets, downloads };
    return { use: async name => caps[name] || null };
  }

  // ---------- importação (só administrador) ----------
  function telaImportar(temMidia, nDocs) {
    const passos = '<b>Importação para a nova WorkZone</b><br><br>' +
      '1. <b>Dados</b> (cartões, comentários, avaliações): ' + (nDocs ? nDocs + ' registros já importados.' : 'ainda não importados.') + ' Escolha o arquivo <b>workzone-dados.json</b> exportado da WorkZone antiga.<br><br>' +
      '2. <b>Imagens e vídeos</b>: ' + (temMidia ? 'já enviados.' : 'ainda não enviados.') + ' Descompacte o <b>workzone-midia.zip</b> e escolha a pasta <b>workzone-midia</b>.';
    msg(passos);
    const fj = document.createElement('input'); fj.type = 'file'; fj.accept = '.json,application/json'; fj.hidden = true;
    const fd = document.createElement('input'); fd.type = 'file'; fd.webkitdirectory = true; fd.multiple = true; fd.hidden = true;
    document.body.append(fj, fd);
    botoes([['1. Escolher workzone-dados.json', () => fj.click(), !nDocs], ['2. Escolher a pasta workzone-midia', () => fd.click(), !temMidia], ['Abrir o WorkZone', () => { location.href = location.origin + location.pathname; }, !!(nDocs && temMidia)]]);
    fj.onchange = async () => {
      const f = fj.files[0]; if (!f) return; botoes([]);
      try {
        const dados = JSON.parse(await f.text()); if (!dados || !Array.isArray(dados.docs)) throw new Error('arquivo inválido');
        msg('Apagando a cópia anterior…');
        const { error: ed } = await sb.from('docs').delete().neq('col', '__nada__'); if (ed) throw ed;
        const linhas = dados.docs.map(d => { const x = { ...d.data }; if (d.col === 'pp') delete x.uid; return { col: d.col, id: d.id, data: x }; });
        Object.entries(dados.pessoas || {}).forEach(([k, v]) => linhas.push({ col: 'legado', id: k, data: { nome: v } }));
        for (let i = 0; i < linhas.length; i += 400) {
          const { error } = await sb.from('docs').upsert(linhas.slice(i, i + 400)); if (error) throw error;
          msg('Importando dados… ' + Math.min(i + 400, linhas.length) + ' de ' + linhas.length);
        }
        msg('Dados importados: ' + linhas.length + ' registros.');
      } catch (e) { msg('Não foi possível importar os dados: ' + esc(e.message || e)); }
      setTimeout(() => location.reload(), 1500);
    };
    fd.onchange = async () => {
      const fs = [...fd.files]; if (!fs.length) return;
      botoes([]); let ok = 0, falha = 0;
      for (const f of fs) {
        const nome = f.webkitRelativePath.split('/').slice(1).join('/') || f.name;
        const destino = nome === 'areas.json' ? 'dados/areas.json' : nome;
        const tipo = f.type || (nome.endsWith('.json') ? 'application/json' : nome.endsWith('.css') ? 'text/css' : 'application/octet-stream');
        const { error } = await sb.storage.from(BUCKET_MIDIA).upload(destino, f, { contentType: tipo, upsert: true });
        error ? falha++ : ok++;
        msg('Enviando imagens e vídeos… ' + (ok + falha) + ' de ' + fs.length + (falha ? ' (' + falha + ' com erro)' : ''));
      }
      msg('Envio concluído: ' + ok + ' arquivos' + (falha ? ', ' + falha + ' com erro' : '') + '.');
      setTimeout(() => location.reload(), 1500);
    };
  }

  iniciar().catch(e => { console.error(e); msg('Algo deu errado ao abrir o WorkZone. Recarregue a página.'); botoes([['Recarregar', () => location.reload(), true]]); });
})();
