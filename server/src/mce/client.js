// Marketing Cloud Engagement REST client (installed package, server-to-server).
// Credentials live in the server-side session only; the browser never sees the secret.

async function getToken({ subdomain, clientId, clientSecret, accountId }) {
  // MCE_AUTH_BASE lets tests point at a local mock instead of the real auth host.
  const authBase = process.env.MCE_AUTH_BASE || `https://${subdomain}.auth.marketingcloudapis.com`;
  const res = await fetch(`${authBase}/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      ...(accountId ? { account_id: accountId } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.message || `MCE auth failed (${res.status})`);
  return {
    accessToken: body.access_token,
    restUrl: body.rest_instance_url.replace(/\/$/, ''),
    soapUrl: `${(body.soap_instance_url || `https://${subdomain}.soap.marketingcloudapis.com/`).replace(/\/$/, '')}/Service.asmx`,
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
  };
}

// First text value of <tag> (namespace prefix tolerated), or null. Responses are flat, so no XML parser is needed.
function xmlText(xml, tag) {
  const m = xml.match(new RegExp(String.raw`<(?:\w+:)?${tag}(?:\s[^>]*)?>([\s\S]*?)</(?:\w+:)?${tag}>`));
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') : null;
}

// Returns a function that calls the MCE REST API, refreshing the token as needed.
export function createMceClient(creds, cache = {}) {
  async function call(path) {
    if (!cache.token || cache.token.expiresAt < Date.now()) cache.token = await getToken(creds);
    console.log(`[mce] GET ${cache.token.restUrl}${path}`);
    const res = await fetch(`${cache.token.restUrl}${path}`, {
      headers: { Authorization: `Bearer ${cache.token.accessToken}` },
    });
    console.log(`[mce] <- ${res.status} ${path}`);
    if (!res.ok) throw new Error(`MCE ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    console.log(`[mce] response keys for ${path}:`, Object.keys(json));
    return json;
  }

  async function soapRetrieve(requestBody) {
    if (!cache.token || cache.token.expiresAt < Date.now()) cache.token = await getToken(creds);
    const { soapUrl, accessToken } = cache.token;
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing">
<s:Header><a:Action s:mustUnderstand="1">Retrieve</a:Action><a:To s:mustUnderstand="1">${soapUrl}</a:To><fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth></s:Header>
<s:Body><RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI"><RetrieveRequest>${requestBody}</RetrieveRequest></RetrieveRequestMsg></s:Body>
</s:Envelope>`;
    const res = await fetch(soapUrl, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: envelope });
    const text = await res.text();
    if (!res.ok) throw new Error(`MCE SOAP retrieve failed (${res.status}): ${text.slice(0, 200)}`);
    return text;
  }

  return {
    async test() {
      await call('/platform/v1/endpoints');
      return { restUrl: cache.token.restUrl };
    },

    // Lists all DEs via SOAP Retrieve: the REST list endpoint demands a $search term on some accounts.
    async listDataExtensions() {
      const props = ['ObjectID', 'CustomerKey', 'Name', 'Description', 'IsSendable', 'CategoryID'];
      const all = [];
      let continueId = null;
      do {
        const xml = await soapRetrieve(continueId
          ? `<ContinueRequest>${continueId}</ContinueRequest>`
          : `<ObjectType>DataExtension</ObjectType>${props.map((p) => `<Properties>${p}</Properties>`).join('')}`);
        const status = xmlText(xml, 'OverallStatus');
        if (status !== 'OK' && status !== 'MoreDataAvailable') {
          throw new Error(`MCE SOAP retrieve failed: ${status || 'no status'} ${xmlText(xml, 'StatusMessage') ?? ''}`.trim());
        }
        for (const block of xml.match(/<Results[\s\S]*?<\/Results>/g) ?? []) {
          all.push({
            id: xmlText(block, 'ObjectID'), key: xmlText(block, 'CustomerKey'), name: xmlText(block, 'Name'),
            description: xmlText(block, 'Description') ?? '',
            isSendable: xmlText(block, 'IsSendable') === 'true', categoryId: Number(xmlText(block, 'CategoryID')) || undefined,
          });
        }
        continueId = status === 'MoreDataAvailable' ? xmlText(xml, 'RequestID') : null;
      } while (continueId);
      console.log(`[mce] listDataExtensions: ${all.length} DEs`);
      return all;
    },

    async getFields(id) {
      const data = await call(`/data/v1/customobjects/${id}/fields`);
      console.log(`[mce] getFields(${id}): fields=${data.fields?.length ?? 'n/a'} items=${data.items?.length ?? 'n/a'}`);
      // The real endpoint returns { fields: [...] }; `items` is kept for older/mock responses.
      return (data.fields ?? data.items ?? [])
        .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
        .map((f) => ({
          name: f.name, type: f.type, length: f.length, scale: f.scale,
          isPrimaryKey: !!f.isPrimaryKey, isRequired: !!f.isRequired, defaultValue: f.defaultValue ?? null,
        }));
    },

    // One page of rows by DE customer key, flattened to { fieldName: value } (primary keys + values).
    async getRows(key, page = 1, pageSize = 1000) {
      // Rows by customer key live under /data/v1/customobjectdata (/data/v1/customobjects/.../rowset 404s).
      const data = await call(`/data/v1/customobjectdata/key/${encodeURIComponent(key)}/rowset?$page=${page}&$pageSize=${pageSize}`);
      const rows = (data.items ?? []).map((r) => ({ ...r.keys, ...r.values }));
      console.log(`[mce] getRows(${key}) page ${page}: ${rows.length} rows (total ${data.count ?? '?'})`);
      if (rows.length) console.log('[mce] sample fetched rows:', JSON.stringify(rows.slice(0, 2), null, 2));
      return { rows, count: data.count ?? null };
    },

    async getRowCount(id) {
      const data = await call(`/data/v1/customobjectdata/${id}/rowset?$pageSize=1`);
      return data.count ?? null;
    },
  };
}
