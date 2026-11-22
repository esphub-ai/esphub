// The device Durable Object serializes appends. A manifest exposes only the
// committed prefix; an interrupted tail upload can be safely overwritten.
const PAGE = 64;
export class Stream {
  constructor(bucket, prefix) {
    this.bucket = bucket;
    this.prefix = prefix;
  }
  async head() {
    return (
      (await (await this.bucket.get(this.prefix))?.json()) || {
        last: 0,
        source: 0,
      }
    );
  }
  async init() {
    if (!(await this.bucket.head(this.prefix)))
      await this.bucket.put(
        this.prefix,
        JSON.stringify({ last: 0, source: 0 }),
      );
  }
  key(index) {
    return this.prefix + ".parts/" + String(index).padStart(10, "0");
  }
  async page(index) {
    return (await (await this.bucket.get(this.key(index)))?.json()) || [];
  }
  async append(records, extra = {}) {
    const head = await this.head();
    let last = head.last;
    let pos = 0;
    while (pos < records.length) {
      const index = Math.floor(last / PAGE),
        offset = last % PAGE;
      const rows = offset ? (await this.page(index)).slice(0, offset) : [];
      if (rows.length !== offset) throw Error("Incomplete committed stream");
      const part = records.slice(pos, pos + PAGE - offset);
      for (const row of part) rows.push({ ...row, seq: ++last });
      await this.bucket.put(this.key(index), JSON.stringify(rows));
      pos += part.length;
    }
    const next = { ...head, ...extra, last };
    await this.bucket.put(this.prefix, JSON.stringify(next));
    return next;
  }
  async read(after, limit = 64) {
    const { last } = await this.head(),
      end = Math.min(last, after + limit),
      records = [];
    for (let first = after; first < end;) {
      const page = await this.page(Math.floor(first / PAGE));
      const n = Math.min(end - first, PAGE - (first % PAGE));
      const part = page.slice(first % PAGE, (first % PAGE) + n);
      if (part.length !== n) throw Error("Incomplete committed stream");
      records.push(...part);
      first += n;
    }
    return { records, cursor: records.at(-1)?.seq ?? after, last };
  }
}
