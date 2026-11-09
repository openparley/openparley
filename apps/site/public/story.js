// Plays the homepage's scroll story. The end states are the default CSS; site.js adds html.story
// (start states) before the first paint, and only when motion is fine. See "Scroll story" in site.css.
(() => {
  const root = document.documentElement;
  const motion = root.classList.contains('story');
  const how = document.querySelector('.how');

  // How it works: the steps take turns in the frame until the visitor picks one. The active step's
  // invisible timer (a CSS animation) is the clock, so hover, focus and being off screen pause it in CSS.
  if (how) {
    const steps = [...how.querySelectorAll('.step')];
    let current = 0;
    const show = (n) => {
      current = n;
      how.dataset.step = n;
      steps.forEach((step, i) => {
        step.classList.toggle('on', i === n - 1);
        step.querySelector('.step-pick').toggleAttribute('aria-current', i === n - 1);
      });
      if (!motion) return;
      for (const el of how.querySelectorAll(`[data-at="${n}"]`)) {
        el.classList.add('s-now');
        el.classList.remove('play');
        void el.offsetWidth;
        el.classList.remove('s-now');
        el.classList.add('play');
      }
    };
    steps.forEach((step, i) => {
      step.append(Object.assign(document.createElement('span'), { className: 'step-time' }));
      step.querySelector('.step-pick').addEventListener('click', () => {
        how.classList.remove('auto');
        show(i + 1);
      });
    });
    how.dataset.ready = '';
    if (!motion) {
      // Reduced motion: the frame keeps its end state (no data-step) until a step is picked.
      steps.at(-1).classList.add('on');
      steps.at(-1).querySelector('.step-pick').setAttribute('aria-current', '');
    } else {
      show(0);
      how.classList.add('auto');
      how.addEventListener('animationend', (event) => {
        if (event.animationName === 'step-time' && how.classList.contains('auto')) show((current % steps.length) + 1);
      });
      new IntersectionObserver(
        ([entry]) => {
          how.classList.toggle('inview', entry.isIntersecting);
          if (entry.isIntersecting && current === 0) show(1);
        },
        { threshold: 0.4 },
      ).observe(how);
    }
  }

  if (!motion) return;
  root.dataset.story = 'on';

  // Typing: one span per character, which CSS reveals in turn. The text itself never changes, so nothing reflows.
  for (const el of document.querySelectorAll('.s-type')) {
    el.replaceChildren(
      ...[...el.textContent].map((char, i) => {
        const span = document.createElement('span');
        span.textContent = char;
        span.style.setProperty('--i', i);
        return span;
      }),
    );
  }

  // Jumps running transitions to their end, so a beat scrolled past mid-way never stays half-played.
  const finish = (el, forever) => {
    el.classList.add('s-now');
    void el.offsetWidth;
    if (!forever) el.classList.remove('s-now');
  };
  const onLeave = (el, callback) =>
    new IntersectionObserver(([entry]) => entry.isIntersecting || callback()).observe(el);

  // Calls back with how many of `items` have their top above `line` (% of the viewport height). The root
  // reaches far above the viewport, so items scrolled past still count, also after jumping to an anchor.
  const track = (items, line, callback) => {
    const passed = new Set();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) isIntersecting ? passed.add(target) : passed.delete(target);
        callback(Math.max(0, ...[...passed].map((el) => items.indexOf(el) + 1)));
      },
      { rootMargin: `100000px 0px ${line - 100}% 0px` },
    );
    for (const el of items) observer.observe(el);
  };

  // Hero, pricing, setup: play once when in view, finish at once when they leave it.
  const beats = new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting, intersectionRatio } of entries) {
        if (intersectionRatio >= 0.3) target.classList.add('play');
        else if (!isIntersecting && target.classList.contains('play')) {
          finish(target, true);
          beats.unobserve(target);
        }
      }
    },
    { threshold: [0, 0.3] },
  );
  for (const el of document.querySelectorAll('[data-beat]')) beats.observe(el);

  // Team: each role that scrolls past drops its pin and preview, and they stay.
  const team = document.querySelector('.team');
  if (team) {
    let shown = 0;
    track([...team.querySelectorAll('.role')], matchMedia('(min-width: 1000px)').matches ? 60 : 85, (count) => {
      if (count <= shown) return;
      shown = count;
      for (const el of team.querySelectorAll('[data-n]')) if (Number(el.dataset.n) <= count) el.classList.add('on');
    });
    onLeave(team, () => finish(team));
  }
})();
