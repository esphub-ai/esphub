const words = ["HMR", "Wireless OTA", "Any coding agent"];
const slot = document.querySelector(".slot");
const reel = document.querySelector(".reel");
const motion = matchMedia("(prefers-reduced-motion: reduce)");
let index = 0;
function fit() {
  const label = reel.lastElementChild;
  const range = document.createRange();
  range.selectNodeContents(label);
  slot.style.width = Math.ceil(range.getBoundingClientRect().width + 2) + "px";
}
function rotate() {
  if (motion.matches || document.hidden || reel.children.length > 1) return;
  const previous = reel.firstElementChild;
  index = (index + 1) % words.length;
  const next = document.createElement("span");
  next.textContent = words[index];
  reel.append(next);
  fit();
  const slide = reel.animate(
    [{ transform: "translateY(0)" }, { transform: "translateY(-50%)" }],
    { duration: 520, easing: "cubic-bezier(.3,.75,.2,1)" },
  );
  slide.onfinish = () => previous.remove();
}
fit();
document.fonts.ready.then(fit);
window.addEventListener("resize", fit);
setInterval(rotate, 3000);
const copy = document.getElementById("copy");
const promptElement = document.getElementById("prompt");
let reset;
copy.addEventListener("click", async () => {
  clearTimeout(reset);
  try {
    await navigator.clipboard.writeText(promptElement.innerText);
    copy.textContent = "Copied ✓";
  } catch {
    const range = document.createRange();
    range.selectNodeContents(promptElement);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copy.textContent = "Text selected · Copy manually";
  }
  reset = setTimeout(() => (copy.textContent = "Copy prompt"), 3200);
});
