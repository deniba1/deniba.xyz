const card = document.getElementById("profile");
const play = document.getElementById("play");
const equalizer = document.getElementById("equalizer");

let playing = true;

// Subtle 3D movement following the mouse
window.addEventListener("mousemove", (event) => {
  if (window.innerWidth < 700) return;

  const x = event.clientX / window.innerWidth - 0.5;
  const y = event.clientY / window.innerHeight - 0.5;

  card.style.transform = `
    perspective(1100px)
    rotateX(${y * -2.2}deg)
    rotateY(${x * 2.2}deg)
    translateY(-2px)
  `;
});

// Reset card when mouse leaves the window
window.addEventListener("mouseleave", () => {
  card.style.transform = "";
});

// Music button
play.addEventListener("click", () => {
  playing = !playing;

  play.textContent = playing ? "▶" : "Ⅱ";
  equalizer.classList.toggle("paused", !playing);
});

// Entrance animation
window.addEventListener("load", () => {
  card.animate(
    [
      {
        opacity: 0,
        transform: "translateY(12px) scale(.985)"
      },
      {
        opacity: 1,
        transform: "translateY(0) scale(1)"
      }
    ],
    {
      duration: 600,
      easing: "cubic-bezier(.2,.8,.2,1)",
      fill: "forwards"
    }
  );
});
