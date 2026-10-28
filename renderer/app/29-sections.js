// ---------- сворачиваемые разделы: левая и правая панели ----------

const SEC_KEY = 'kabinet.sec.';

function sectionOpen(name) {
  try {
    const v = localStorage.getItem(SEC_KEY + name);
    return v === null ? name !== 'trash' : v === '1'; // корзина по умолчанию свёрнута
  } catch {
    return name !== 'trash';
  }
}

function setSection(name, open, save = true) {
  const el = document.querySelector(`[data-sec="${name}"]`);
  if (!el) return;
  el.classList.toggle('collapsed', !open);
  const head = el.querySelector('.sec-head');
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (save) { try { localStorage.setItem(SEC_KEY + name, open ? '1' : '0'); } catch { /* ignore */ } }
}

function expandSection(name) {
  setSection(name, true);
}

function wireSections() {
  document.querySelectorAll('[data-sec]').forEach((el) => {
    const name = el.dataset.sec;
    const head = el.querySelector('.sec-head');
    setSection(name, sectionOpen(name), false);
    const toggle = () => setSection(name, el.classList.contains('collapsed'));
    head.addEventListener('click', (e) => {
      if (e.target.closest('button')) return; // «+» в заголовке не сворачивает
      toggle();
    });
    head.addEventListener('keydown', (e) => {
      if (e.target !== head) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}
