// Minimal S3 (MinIO) client — stdlib only, AWS Signature V4, path-style addressing.
//
// The router's one runtime dep is `pg`; this archiver keeps that ethos — no aws-sdk, no minio pkg.
// Everything here is `node:https` + `node:crypto`. Path-style (`/<bucket>/<key>`) because MinIO does
// not do virtual-host buckets by default, and the NAS endpoint is a bare host.
//
// Covers exactly what the archiver needs: PUT, GET, HEAD. SigV4 over the payload hash (never
// UNSIGNED-PAYLOAD, so an in-flight flip of a byte is caught by the service).
const https = require("node:https");
const http = require("node:http");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
const hmac = (key, s) => crypto.createHmac("sha256", key).update(s).digest();
// SigV4 canonicalises with RFC-3986 encoding, and critically does NOT encode "/" in the path.
const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split("/").map(enc).join("/");

function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac("AWS4" + secret, date), region), service), "aws4_request");
}

class S3 {
  // endpoint e.g. "https://nas-s3.blpk.cc" (public) or "http://192.168.0.7:9100" (LAN).
  constructor({ endpoint, accessKey, secretKey, region = "us-east-1" }) {
    if (!endpoint || !accessKey || !secretKey) throw new Error("s3: endpoint/accessKey/secretKey required");
    this.u = new URL(endpoint);
    this.accessKey = accessKey; this.secretKey = secretKey; this.region = region;
    this.agent = this.u.protocol === "http:" ? http : https;
  }

  // One signed request. `key` is the object path WITHOUT a leading slash; bucket is prepended → path-style.
  _req(method, bucket, key, body = Buffer.alloc(0), extraHeaders = {}) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");   // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8);
    const host = this.u.host;
    const canonicalUri = "/" + encPath(bucket) + (key ? "/" + encPath(key) : "");
    const payloadHash = sha256hex(body);
    const headers = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extraHeaders,
    };
    // Canonical headers: sorted, lowercased name, trimmed value.
    const signedNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonicalHeaders = signedNames.map((h) => `${h}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === h)]).trim()}\n`).join("");
    const signedHeaders = signedNames.join(";");
    const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
    const sig = hmac(signingKey(this.secretKey, dateStamp, this.region, "s3"), toSign).toString("hex");
    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

    return new Promise((resolve, reject) => {
      const req = this.agent.request(
        { method, host: this.u.hostname, port: this.u.port || (this.u.protocol === "http:" ? 80 : 443), path: canonicalUri, headers },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
      req.on("error", reject);
      if (body.length) req.write(body);
      req.end();
    });
  }

  async putObject(bucket, key, body, contentType = "application/octet-stream") {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const r = await this._req("PUT", bucket, key, buf, { "content-type": contentType, "content-length": String(buf.length) });
    if (r.status !== 200) throw new Error(`PUT ${key} → ${r.status}: ${r.body.toString().slice(0, 300)}`);
    return { etag: (r.headers.etag || "").replace(/"/g, ""), bytes: buf.length };
  }

  // GET an object. Pass {range:"bytes=0-0"} to fetch a single byte — enough to prove the object
  // exists and read its total size off the Content-Range header, without downloading a big blob.
  async getObject(bucket, key, { range } = {}) {
    const r = await this._req("GET", bucket, key, Buffer.alloc(0), range ? { range } : {});
    if (r.status === 404) return null;
    if (r.status !== 200 && r.status !== 206) throw new Error(`GET ${key} → ${r.status}: ${r.body.toString().slice(0, 300)}`);
    return r.body;
  }

  // Confirm an object landed and return its total byte length, or null if absent. Uses a ranged GET,
  // NOT HeadObject: this MinIO deployment (behind Cloudflare) answers HEAD with 403 even where GET
  // succeeds, so HEAD is useless as a verifier here. `bytes=0-0` returns 206 + a
  // `Content-Range: bytes 0-0/<total>` from which the real size is read. The CF proxy also rejects
  // some range requests with 400 — on any non-404 range failure, fall back to a full GET and measure.
  async verifyObject(bucket, key) {
    const r = await this._req("GET", bucket, key, Buffer.alloc(0), { range: "bytes=0-0" });
    if (r.status === 404) return null;
    if (r.status === 206) {
      const total = parseInt(((r.headers["content-range"] || "").split("/")[1] || "0"), 10);  // "bytes 0-0/12345"
      if (total > 0) return { bytes: total };
    }
    if (r.status === 200) return { bytes: parseInt(r.headers["content-length"] || "0", 10) };  // no range support → full body length
    // 400/403/etc from the proxy on a range request: fall back to a plain GET and count the bytes.
    const full = await this._req("GET", bucket, key);
    if (full.status === 404) return null;
    if (full.status !== 200) throw new Error(`verify ${key} → ${r.status}/${full.status}`);
    return { bytes: full.body.length };
  }
}

module.exports = { S3 };
