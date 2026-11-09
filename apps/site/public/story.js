// Plays the homepage's scroll story. The end states are the default CSS; site.js adds html.story
// (start states) before the first paint, and only when motion is fine. See "Scroll story" in site.css.
(() => {
  const root = document.documentElement;
  if (!root.classList.contains('story')) return;
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

  // How it works: the step at the line sets the frame's state; each state's own animation plays once.
  const how = document.querySelector('.how');
  if (how) {
    const show = (step) => {
      how.dataset.step = step;
      for (const el of how.querySelectorAll(`[data-at="${step}"]`)) el.classList.add('play');
    };
    show(0);
    track([...how.querySelectorAll('.step')], matchMedia('(min-width: 900px)').matches ? 40 : 72, show);
    onLeave(how, () => finish(how));
  }

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
