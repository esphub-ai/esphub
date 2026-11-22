// First deployment bootstrap; parallel deployments may see the bucket created by a peer.
const account = process.env.CLOUDFLARE_ACCOUNT_ID,
  token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw Error("Cloudflare CI credentials are missing");
const base =
  "https://api.cloudflare.com/client/v4/accounts/" + account + "/r2/buckets";
const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  },
  name = "esphub-production";
const check = () => fetch(base + "/" + name, { headers });
if (!(await check()).ok) {
  const r = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ name }),
  });
  if (!r.ok && !(await check()).ok)
    throw Error("Unable to provision R2 bucket (HTTP " + r.status + ")");
}
