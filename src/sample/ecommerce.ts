import type { Database } from '../engine';

/** Deterministic PRNG (mulberry32) so the demo dataset is identical on every load. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ava', 'Noah', 'Mia', 'Liam', 'Zoe', 'Ethan', 'Isla', 'Lucas', 'Aria', 'Mateo', 'Nora', 'Kai',
  'Layla', 'Omar', 'Freya', 'Hugo', 'Sana', 'Ravi', 'Elena', 'Jonas', 'Amara', 'Felix', 'Yuki', 'Tariq'];
const LAST = ['Rahman', 'Silva', 'Chen', 'Okafor', 'Novak', 'Haddad', 'Larsen', 'Tanaka', 'Costa', 'Iyer',
  'Becker', 'Moreau', 'Khan', 'Rossi', 'Nguyen', 'Petrov', 'Ahmed', 'Garcia', 'Lindqvist', 'Mensah'];
const COUNTRIES = ['Bangladesh', 'Germany', 'Japan', 'Brazil', 'Canada', 'India', 'Nigeria', 'France',
  'Australia', 'Sweden', 'Mexico', 'Egypt'];
const CATEGORIES: Record<string, { nouns: string[]; min: number; max: number }> = {
  Electronics: { nouns: ['Headphones', 'Keyboard', 'Monitor', 'Webcam', 'Speaker', 'Charger'], min: 19, max: 899 },
  Books: { nouns: ['Novel', 'Cookbook', 'Atlas', 'Biography', 'Handbook'], min: 6, max: 60 },
  Home: { nouns: ['Lamp', 'Kettle', 'Blanket', 'Planter', 'Mug Set', 'Shelf'], min: 9, max: 240 },
  Outdoors: { nouns: ['Tent', 'Backpack', 'Flask', 'Headlamp', 'Hammock'], min: 12, max: 420 },
  Toys: { nouns: ['Puzzle', 'Robot Kit', 'Board Game', 'Kite', 'Blocks'], min: 5, max: 120 },
};
const ADJECTIVES = ['Classic', 'Compact', 'Premium', 'Eco', 'Smart', 'Vintage', 'Ultra', 'Everyday'];
const STATUSES = ['delivered', 'delivered', 'delivered', 'delivered', 'shipped', 'processing', 'cancelled', 'returned'];

export const SAMPLE_SIZES = { customers: 1000, products: 200, orders: 8000 };

/** Create and populate a small e-commerce schema for the playground. */
export function loadSampleData(db: Database): void {
  db.execute(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      country TEXT NOT NULL,
      signup_year INTEGER NOT NULL
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      order_date TEXT NOT NULL
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL
    );
    CREATE INDEX orders_customer_idx ON orders (customer_id);
    CREATE INDEX order_items_order_idx ON order_items (order_id);
  `);

  const random = mulberry32(20240607);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

  // Rows go straight into storage: same constraint checks and index maintenance as
  // INSERT statements, without parsing ~30,000 of them at page load.
  const customers = db.getTable('customers');
  for (let i = 1; i <= SAMPLE_SIZES.customers; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    customers.insert([i, `${first} ${last}`, `${first}.${last}${i}@example.com`.toLowerCase(), pick(COUNTRIES), int(2016, 2024)]);
  }

  const products = db.getTable('products');
  const prices: number[] = [0];
  const categoryNames = Object.keys(CATEGORIES);
  for (let i = 1; i <= SAMPLE_SIZES.products; i++) {
    const category = categoryNames[i % categoryNames.length];
    const spec = CATEGORIES[category];
    const price = Math.round((spec.min + random() ** 2 * (spec.max - spec.min)) * 100) / 100;
    prices.push(price);
    products.insert([i, `${pick(ADJECTIVES)} ${pick(spec.nouns)} ${i}`, category, price]);
  }

  const orders = db.getTable('orders');
  const items = db.getTable('order_items');
  for (let i = 1; i <= SAMPLE_SIZES.orders; i++) {
    let customer: number;
    // Customers whose id is divisible by 23 never order, so anti-join examples have results.
    do {
      // Squaring skews towards low ids: a handful of customers order far more than the rest.
      customer = 1 + Math.floor(random() ** 2 * SAMPLE_SIZES.customers);
    } while (customer % 23 === 0);
    const date = `${int(2022, 2024)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
    orders.insert([i, customer, pick(STATUSES), date]);
    for (let n = int(1, 4); n > 0; n--) {
      const product = int(1, SAMPLE_SIZES.products);
      items.insert([null, i, product, int(1, 3), prices[product]]);
    }
  }
}
