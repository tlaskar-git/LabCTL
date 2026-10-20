// Compliance report: GET /api/compliance (rows and summary), GET /api/compliance.csv, GET /api/compliance/eol (the table).
// Exports (app, ctx) => void. The logic is in src/compliance.js.
const compliance = require('../compliance');
const { PRODUCTS } = require('../compliance-eol');

module.exports = (app, ctx) => {
  app.get('/api/compliance', (req, res) => res.json(compliance.build(ctx)));
  app.get('/api/compliance.csv', (req, res) => {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="labctl-compliance.csv"');
    res.send(compliance.toCsv(compliance.build(ctx)));
  });
  app.get('/api/compliance/eol', (req, res) => res.json(PRODUCTS.map(p => ({ product: p.product, eol: p.eol }))));
};
