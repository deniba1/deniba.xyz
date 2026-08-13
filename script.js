// Subtle reveal animation
const revealItems = document.querySelectorAll(
  ".project, .skill, .stats div, .contact-card"
);

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;

      entry.target.animate(
        [
          {
            opacity: 0,
            transform: "translateY(18px)",
          },
          {
            opacity: 1,
            transform: "translateY(0)",
          },
        ],
        {
          duration: 650,
          easing: "cubic-bezier(.2,.7,.2,1)",
          fill: "forwards",
        }
      );

      observer.unobserve(entry.target);
    });
  },
  {
    threshold: 0.08,
  }
);

revealItems.forEach((item) => observer.observe(item));
