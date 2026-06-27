# Golden Wicker Café — QR Ordering System

A full-stack café ordering website: customers scan a QR code at their table, browse the menu, place orders, and wait for admin confirmation. Admins manage orders and the menu from a separate panel.

## Quick Start

```bash
npm install
npm start
```

- **Customer site:** http://localhost:3000/?table=1
- **Admin panel:** http://localhost:3000/admin.html
- **Default admin password:** `admin123` (set `ADMIN_PASSWORD` env var to change)

## QR Codes

Point each table's QR code to:

```
http://YOUR-SERVER-IP:3000/?table=TABLE_NUMBER
```

Example: `http://192.168.1.10:3000/?table=5`

## User Flow

1. Scan QR → lands on homepage with auto-scrolling photos
2. View intro + contact info, tap **View Menu**
3. Add items to cart (optional custom notes per item)
4. Confirm order → waits for admin acceptance
5. If accepted → "being prepared" + **Call Waiter** button
6. If rejected → shown rejection message

## Admin Flow

**Orders tab:** See incoming orders, accept/reject, mark preparing/ready. Waiter calls appear at the top.

**Menu & Photos tab:** Edit café info, carousel photos, add/edit/delete menu items with images and prices.

## Tech Stack

- HTML, CSS, JavaScript (frontend)
- Node.js, Express, Socket.io (backend)
- JSON file storage (`server/data/store.json`)
