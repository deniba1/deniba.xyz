{`const card = document.getElementById("card");
const play = document.getElementById("play");

document.addEventListener("mousemove", (e) => {
  const x = e.clientX / window.innerWidth - 0.5;
  const y = e.clientY / window.innerHeight - 0.5;

  card.style.transform =
    \`rotateY(\${x * 5}deg) rotateX(\${-y * 5}deg)\`;
});

document.addEventListener("mouseleave", () => {
  card.style.transform = "rotateY(0) rotateX(0)";
});

let playing = false;

play.addEventListener("click", () => {
  playing = !playing;
  play.textContent = playing ? "❚❚" : "▶";
});

// Fake local view counter
const count = document.getElementById("viewCount");
let views = Number(count.textContent.replace(",", ""));

setInterval(() => {
  if (Math.random() > 0.7) {
    views++;
    count.textContent = views.toLocaleString();
  }
}, 5000);`}
