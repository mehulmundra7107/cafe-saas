const SLIDE_HOLD_MS = 2500;
const SLIDE_TRANSITION_MS = 700;

let carouselTimers = [];

async function loadHome() {
  const table = getTableNumber();
  const tableEl = document.getElementById("tableBadge");
  if (tableEl) tableEl.textContent = `Table ${table}`;

  try {
    const res = await fetch(withCafeSlug("/api/cafe"));
    const data = await res.json();
    const { cafeInfo, heroPhotos } = data;

    document.getElementById("cafeName").textContent = cafeInfo.name;
    document.getElementById("introShort").textContent = cafeInfo.introShort;
    document.getElementById("introFull").textContent = cafeInfo.introFull;
    document.title = cafeInfo.name;

    document.getElementById("contactPhone").textContent = cafeInfo.contact.phone;
    document.getElementById("contactEmail").textContent = cafeInfo.contact.email;
    document.getElementById("contactAddress").textContent = cafeInfo.contact.address;
    document.getElementById("contactHours").textContent = cafeInfo.contact.hours;

    buildCarousel(heroPhotos);
  } catch (err) {
    console.error(err);
  }
}

function clearCarouselTimers() {
  carouselTimers.forEach(clearTimeout);
  carouselTimers = [];
}

function scheduleCarouselStep(track, photoCount, state) {
  const holdTimer = setTimeout(() => {
    state.index += 1;
    track.style.transition = `transform ${SLIDE_TRANSITION_MS}ms ease-in-out`;
    track.style.transform = `translateX(-${state.index * 100}vw)`;

    const afterTransition = setTimeout(() => {
      if (state.index >= photoCount) {
        state.index = 0;
        track.style.transition = "none";
        track.style.transform = "translateX(0)";
        // Force reflow to apply the transition-none instantly
        track.offsetHeight;
        
        requestAnimationFrame(() => {
          track.style.transition = `transform ${SLIDE_TRANSITION_MS}ms ease-in-out`;
          scheduleCarouselStep(track, photoCount, state);
        });
        return;
      }

      scheduleCarouselStep(track, photoCount, state);
    }, SLIDE_TRANSITION_MS);

    carouselTimers.push(afterTransition);
  }, SLIDE_HOLD_MS);

  carouselTimers.push(holdTimer);
}

function buildCarousel(photos) {
  const track = document.getElementById("heroTrack");
  if (!track || !photos.length) return;

  clearCarouselTimers();

  const slides = [...photos, ...photos];

  track.innerHTML = slides
    .map(
      (photo) => `
      <div class="hero-slide">
        <img src="${photo.url || photo}" alt="Café interior" loading="lazy" />
      </div>`
    )
    .join("");

  track.style.transition = "none";
  track.style.transform = "translateX(0)";

  const state = { index: 0 };
  scheduleCarouselStep(track, photos.length, state);
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof initCustomerApp === "function") {
    initCustomerApp(loadHome);
  } else {
    loadHome();
  }
});
