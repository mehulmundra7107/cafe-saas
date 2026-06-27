const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const storePath = path.join(__dirname, 'server/data/store.json');
const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));

if (!store.orders) store.orders = [];

const menuItems = store.menuItems || [];
if (menuItems.length === 0) {
  console.log("No menu items to order");
  process.exit(1);
}

const now = new Date();
// Generate orders for the last 35 days
for (let i = 0; i < 35; i++) {
  const date = new Date(now);
  date.setDate(now.getDate() - i);
  
  // Create 1 to 5 orders per day
  const numOrders = Math.floor(Math.random() * 5) + 1;
  
  for (let j = 0; j < numOrders; j++) {
    // Randomize time during the day
    date.setHours(8 + Math.floor(Math.random() * 12), Math.floor(Math.random() * 60));
    
    // Pick 1-3 random items
    const itemsCount = Math.floor(Math.random() * 3) + 1;
    const items = [];
    let total = 0;
    
    for (let k = 0; k < itemsCount; k++) {
      const randomMenuItem = menuItems[Math.floor(Math.random() * menuItems.length)];
      const qty = Math.floor(Math.random() * 2) + 1;
      items.push({
        id: randomMenuItem.id,
        name: randomMenuItem.name,
        price: randomMenuItem.price,
        quantity: qty
      });
      total += randomMenuItem.price * qty;
    }
    
    store.orders.push({
      id: uuidv4(),
      tableNumber: String(Math.floor(Math.random() * 10) + 1),
      items,
      status: "ready", // Historical orders are usually completed
      total: total,
      createdAt: date.toISOString(),
      updatedAt: date.toISOString()
    });
  }
}

// Sort orders by createdAt descending
store.orders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
console.log(`Added test orders. Total orders now: ${store.orders.length}`);
