const page = document.body.dataset.page;
document.querySelector(`[data-nav="${page}"]`)?.classList.add('active');

const toggle = document.querySelector('.nav-toggle');
const nav = document.querySelector('#site-nav');
toggle?.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
});

document.querySelectorAll('pre').forEach((pre) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-code';
  button.textContent = 'COPY';
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(pre.innerText.replace(/COPY|COPIED!/g, '').trim());
    button.textContent = 'COPIED!';
    setTimeout(() => { button.textContent = 'COPY'; }, 1400);
  });
  pre.append(button);
});

const style = document.createElement('style');
style.textContent = '.copy-code{position:absolute;top:8px;right:8px;border:1px solid #526079;background:#19283d;color:#b9f34a;padding:5px 8px;font:10px "DM Mono",monospace;cursor:pointer}.copy-code:hover{background:#b9f34a;color:#111c2d}';
document.head.append(style);
