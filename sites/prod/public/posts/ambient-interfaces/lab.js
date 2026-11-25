/* Issue 04 Interactive Calibrator — Interface Chrome vs. Quiet Intent */

const lab = document.querySelector("[data-quiet-lab]");
if (lab) {
  const isEn = document.documentElement.lang.toLowerCase().startsWith("en");
  const slider = document.getElementById("chrome-noise-slider");
  const out = document.getElementById("chrome-noise-out");
  const stage = document.getElementById("quiet-specimen-stage");
  const entropyEl = document.getElementById("quiet-entropy-val");
  const focusEl = document.getElementById("quiet-focus-val");
  const noteEl = document.getElementById("quiet-note");
  const meterBar = document.getElementById("quiet-meter-bar");

  function render(level) {
    const n = Number(level);
    /* 0 = Quiet Swiss Editorial, 100 = Over-Decorated Dashboard Chrome */
    stage.style.setProperty("--noise-level", String(n / 100));
    stage.dataset.chromeState = n <= 20 ? "quiet" : n <= 60 ? "mixed" : "noisy";

    out.textContent = isEn
      ? n <= 20
        ? `${n}% (Quiet Editorial)`
        : n <= 60
          ? `${n}% (Moderate Chrome)`
          : `${n}% (Chrome Overload)`
      : n <= 20
        ? `${n}%（宁静排印）`
        : n <= 60
          ? `${n}%（轻度控件）`
          : `${n}%（装饰过度）`;

    const signalPct = Math.round(94 - n * 0.56);
    const chromeCount = Math.round((n / 100) * 14);
    const unitEn = chromeCount === 1 ? "decorative element" : "decorative elements";
    entropyEl.textContent = `${chromeCount} ${isEn ? unitEn : "个装饰性元素"}`;
    focusEl.textContent = `${signalPct}%`;
    meterBar.style.inlineSize = `${signalPct}%`;

    if (n <= 20) {
      noteEl.textContent = isEn
        ? "Zero boxes around controls, no status ribbons or dots. The headline and idea own 100% of the reader's gaze."
        : "移除按钮方框、顶部状态条与红点贴纸，视线毫无阻碍地落在标题与内容本身。";
    } else if (n <= 60) {
      noteEl.textContent = isEn
        ? "Borders and badges begin competing with the prose, fracturing vertical rhythm."
        : "边框与徽章开始争夺注意力，打断原本安静的阅读节奏。";
    } else {
      noteEl.textContent = isEn
        ? "Classic chrome fatigue: nested boxes, pulsing status dots, and exposed system badges drown out the actual message."
        : "典型的装饰过度：嵌套方框、状态红点与系统标签喧宾夺主，淹没了真正想表达的观点。";
    }
  }

  slider.addEventListener("input", () => render(slider.value));
  render(slider.value);
}
