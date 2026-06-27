let allItems = [];
let activeCategory = "All";

async function loadMenu() {
  try {
    const res = await fetch(withCafeSlug("/api/menu"));
    allItems = await res.json();
    renderCategories();
    renderMenu();
  } catch (err) {
    document.getElementById("menuGrid").innerHTML =
      '<p class="menu-empty">Could not load menu. Please try again.</p>';
  }
}

function getCategories() {
  const cats = [...new Set(allItems.map((i) => i.category))];
  return ["All", ...cats.sort()];
}

function renderCategories() {
  const container = document.getElementById("categoryPills");
  container.innerHTML = getCategories()
    .map(
      (cat) =>
        `<button class="category-pill${cat === activeCategory ? " active" : ""}" data-cat="${cat}">${cat}</button>`
    )
    .join("");

  container.querySelectorAll(".category-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeCategory = btn.dataset.cat;
      renderCategories();
      renderMenu();
    });
  });
}

function renderMenu() {
  const grid = document.getElementById("menuGrid");
  const filtered =
    activeCategory === "All"
      ? allItems
      : allItems.filter((i) => i.category === activeCategory);

  if (!filtered.length) {
    grid.innerHTML = '<p class="menu-empty">No items in this category yet.</p>';
    return;
  }

  grid.innerHTML = filtered.map((item) => renderCard(item)).join("");

  grid.querySelectorAll(".menu-card").forEach((card) => {
    const id = card.dataset.id;
    const item = allItems.find((i) => i.id === id);
    let qty = 1;

    const qtyEl = card.querySelector(".qty-value");
    card.querySelector(".qty-minus").addEventListener("click", () => {
      qty = Math.max(1, qty - 1);
      qtyEl.textContent = qty;
    });
    card.querySelector(".qty-plus").addEventListener("click", () => {
      qty++;
      qtyEl.textContent = qty;
    });

    card.querySelector(".add-btn").addEventListener("click", () => {
      if (item.inStock === false) return;
      const note = card.querySelector(".custom-note-input").value;
      addToCart(item, qty, note);
      showToast(`Added ${item.name} to cart`);
      qty = 1;
      qtyEl.textContent = 1;
      card.querySelector(".custom-note-input").value = "";
    });
  });
}

function renderCard(item) {
  const isOut = item.inStock === false;
  return `
    <article class="menu-card glass ${isOut ? 'out-of-stock' : ''}" data-id="${item.id}">
      <div class="menu-card-image">
        <img src="${item.image}" alt="${item.name}" loading="lazy" />
        ${isOut ? '<div class="out-of-stock-tag">Out of Stock</div>' : ''}
      </div>
      <div class="menu-card-body">
        <div class="menu-card-top">
          <h3>${item.name}</h3>
          <span class="menu-price">${formatPrice(item.price)}</span>
        </div>
        <p class="menu-desc">${item.description}</p>
        <div class="menu-card-actions">
          <input type="text" class="custom-note-input" placeholder="Custom note (e.g. no sugar, extra hot…)" maxlength="120" ${isOut ? 'disabled' : ''} />
          <div class="add-row">
            <div class="qty-control">
              <button type="button" class="qty-btn qty-minus" aria-label="Decrease" ${isOut ? 'disabled' : ''}>−</button>
              <span class="qty-value">1</span>
              <button type="button" class="qty-btn qty-plus" aria-label="Increase" ${isOut ? 'disabled' : ''}>+</button>
            </div>
            <button type="button" class="btn btn-primary add-btn" ${isOut ? 'disabled' : ''}>${isOut ? 'Out of Stock' : 'Add to Cart'}</button>
          </div>
        </div>
      </div>
    </article>`;
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof initCustomerApp === "function") {
    initCustomerApp(loadMenu);
  } else {
    loadMenu();
  }
});

let socket = io();
socket.on("menu:updated", () => {
  loadMenu();
});
