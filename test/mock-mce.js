// Local stand-in for the MCE auth + REST APIs, used to exercise the UI without real credentials.
// Run: node test/mock-mce.js   (then start the server with MCE_AUTH_BASE=http://localhost:4010)
import http from 'node:http';

const PORT = 4010;
const DES = [
  { id: 'de-1', key: 'customers', name: 'Customers', isSendable: true, fields: [
    { name: 'SubscriberKey', type: 'Text', isPrimaryKey: true, ordinal: 1 },
    { name: 'First Name', type: 'Text', ordinal: 2 },
    { name: 'Email', type: 'EmailAddress', ordinal: 3 },
    { name: 'Joined', type: 'Date', ordinal: 4 },
  ], count: 1200 },
  { id: 'de-2', key: 'orders', name: 'Orders 2024', fields: [
    { name: 'Order Total', type: 'Decimal', ordinal: 1 },
    { name: 'Placed At', type: 'Date', ordinal: 2 },
  ], count: 56 },
  { id: 'de-3', key: 'files', name: 'Has Blob', fields: [
    { name: 'Id', type: 'Text', isPrimaryKey: true, ordinal: 1 },
    { name: 'Doc', type: 'Blob', ordinal: 2 },
  ], count: 3 },
];

const send = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/v2/token') return send(res, { access_token: 'mock', expires_in: 1080, rest_instance_url: `http://localhost:${PORT}/`, soap_instance_url: `http://localhost:${PORT}/` });
  if (url.pathname === '/Service.asmx') {
    const results = DES.map((d) => `<Results><ObjectID>${d.id}</ObjectID><CustomerKey>${d.key}</CustomerKey><Name>${d.name}</Name><IsSendable>${!!d.isSendable}</IsSendable></Results>`).join('');
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(`<Envelope><Body><RetrieveResponseMsg><OverallStatus>OK</OverallStatus><RequestID>mock</RequestID>${results}</RetrieveResponseMsg></Body></Envelope>`);
  }
  if (url.pathname === '/platform/v1/endpoints') return send(res, []);
  if (url.pathname === '/data/v1/customobjects') return send(res, { items: DES.map(({ fields, count, ...d }) => d) });
  const m = url.pathname.match(/^\/data\/v1\/customobjects\/([^/]+)\/(fields|rowset)$/);
  const de = m && DES.find((d) => d.id === m[1]);
  if (de && m[2] === 'fields') return send(res, { fields: de.fields });
  if (de && m[2] === 'rowset') return send(res, { count: de.count, items: [] });
  send(res, { message: 'not found' }, 404);
}).listen(PORT, () => console.log(`mock MCE on ${PORT}`));
