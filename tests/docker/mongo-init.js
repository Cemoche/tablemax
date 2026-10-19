// Seeds the MongoDB test server (run once by the image's entrypoint, as root).
// tablemax_test: collections `orders` and `customers`, view `paid_orders`;
// user `reader` / `tablemax` (in admin) with the `read` role on tablemax_test only.
const t = db.getSiblingDB("tablemax_test");

t.customers.insertMany([
  { _id: 1, name: "Ada", city: "London" },
  { _id: 2, name: "Linus", city: "Helsinki" },
  { _id: 3, name: "Grace", city: "New York" },
]);

t.orders.insertMany([
  { _id: 1, customer: 1, status: "paid", total: 120.5 },
  { _id: 2, customer: 2, status: "open", total: 40 },
  { _id: 3, customer: 1, status: "paid", total: 15.25 },
  { _id: 4, customer: 3, status: "cancelled", total: 99 },
]);

t.createView("paid_orders", "orders", [{ $match: { status: "paid" } }]);

db.getSiblingDB("admin").createUser({
  user: "reader",
  pwd: "tablemax",
  roles: [{ role: "read", db: "tablemax_test" }],
});
