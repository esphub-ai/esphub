// Multi-board projects: personal upload presigning, project metadata and preview
// images, immutable per-board app releases, public discovery, and downloads.
import { apiOrigin, projectAppUrl, projectImageUrl } from "../../../shared/identity.js";
import { fail } from "./auth.js";
import { boardIdPattern } from "./boards.js";
import { inTransaction } from "./database.js";
import { versionPattern } from "./firmware.js";
import { uuidPattern } from "./ids.js";
import { maxFlashBytes } from "./layout.js";
import {
  copyStagedObject,
  r2Config,
  signPresignedPut,
  stagingKey,
  uploadExpirySeconds,
} from "./r2.js";

const maxUserUploads = 20;
const maxProjectImages = 10;
const maxImageBytes = 5 * 1024 * 1024;
const sha256Pattern = /^[0-9a-f]{64}$/;
const revisionPattern = /^[0-9a-f]{40}$/;
const repoPathPattern = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const dotSegmentPattern = /(^|\/)\.\.?(\/|$)/;
const uuidInsensitive = new RegExp(uuidPattern.source, "i");
const vendorPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const socPattern = /^esp32[a-z0-9]*$/;
const tagPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const authorIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const maxProjectTags = 10;
const maxTagLength = 32;
const allowedProjectSorts = new Set(["recent", "name", "boards"]);
const defaultProjectsLimit = 18;
const maxProjectsLimit = 100;

export const imageExtensions = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
};
export const imageContentTypes = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
};
const allowedUploadTypes = {
  "application/octet-stream": maxFlashBytes,
  "image/webp": maxImageBytes,
  "image/png": maxImageBytes,
  "image/jpeg": maxImageBytes,
};

const createProjectKeys = new Set([
  "name",
  "description",
  "repo_url",
  "repo_path",
  "upstream_url",
  "tags",
  "author_id",
]);
const updateProjectKeys = new Set([
  "name",
  "description",
  "repo_url",
  "repo_path",
  "upstream_url",
  "images",
  "tags",
  "author_id",
]);
const imageInputKeys = new Set([
  "upload_id",
  "sha256",
  "size",
  "content_type",
  "is_cover",
]);
const releaseKeys = new Set([
  "board_id",
  "version",
  "sdk_version",
  "idf_version",
  "source_revision",
  "promote",
  "app",
]);
const releaseAppKeys = new Set(["upload_id", "size", "sha256", "elf_sha256"]);

export const projectImageObjectKey = (projectId, sha256, ext) =>
  `projects/${projectId}/images/${sha256}.${ext}`;
export const projectReleaseObjectKey = (projectId, boardId, version) =>
  `projects/${projectId}/releases/${boardId}/${version}/app.bin`;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(obj, allowed, prefix = "") {
  for (const key of Object.keys(obj))
    if (!allowed.has(key)) fail(400, `Unexpected ${prefix}${key}`);
}

function parseProjectId(raw, status = 404, message = "Project not found") {
  if (typeof raw !== "string" || !uuidInsensitive.test(raw)) fail(status, message);
  return raw.toLowerCase();
}

function parseName(value) {
  if (typeof value !== "string" || value.includes("\0")) fail(400, "Invalid name");
  const trimmed = value.trim();
  if (!trimmed.length || trimmed.length > 120) fail(400, "Invalid name");
  return trimmed;
}

function parseDescription(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.includes("\0") || value.length > 4000)
    fail(400, "Invalid description");
  return value;
}

function parseRepoUrl(value) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    !value.startsWith("https://") ||
    value.length > 512 ||
    value.includes("\0") ||
    /[\s\\#]/.test(value)
  )
    fail(400, "Invalid repo_url");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(400, "Invalid repo_url");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname
  )
    fail(400, "Invalid repo_url");
  return value;
}

function parseRepoPath(value, repoUrl) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !repoPathPattern.test(value) ||
    dotSegmentPattern.test(value)
  )
    fail(400, "Invalid repo_path");
  if (!repoUrl) fail(400, "repo_path requires repo_url");
  return value;
}

function parseOptionalLabel(value, field, maxLen = 64) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.includes("\0")) fail(400, `Invalid ${field}`);
  const trimmed = value.trim();
  if (!trimmed.length || trimmed.length > maxLen) fail(400, `Invalid ${field}`);
  return trimmed;
}

export function parseUpstreamUrl(value, { defaultNull = false } = {}) {
  if (value === undefined) return defaultNull ? null : undefined;
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !value.startsWith("https://") ||
    value.length > 1024 ||
    value.includes("\0") ||
    /[\s\\]/.test(value)
  )
    fail(400, "Invalid upstream_url");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(400, "Invalid upstream_url");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname
  )
    fail(400, "Invalid upstream_url");
  return value;
}

export function parseTags(value, { defaultEmpty = false } = {}) {
  if (value === undefined) return defaultEmpty ? [] : undefined;
  if (!Array.isArray(value) || value.length > maxProjectTags)
    fail(400, `tags must be an array of at most ${maxProjectTags} entries`);
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      raw.length > maxTagLength ||
      !tagPattern.test(raw)
    )
      fail(400, "Invalid tag");
    if (!seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

export function parseAuthorId(value, { defaultNull = false } = {}) {
  if (value === undefined) return defaultNull ? null : undefined;
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    !authorIdPattern.test(value)
  )
    fail(400, "Invalid author_id");
  return value;
}

function parseJsonValue(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function formatAuthor(row) {
  if (!row || !row.id) return null;
  return {
    id: row.id,
    name: row.name,
    logo_url: row.logo_url ?? null,
    url: row.url ?? null,
  };
}

function parseRowTags(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return [];
}

function imageUrlFor(projectId, sha256, contentType) {
  const ext = imageExtensions[contentType];
  return ext ? projectImageUrl(projectId, sha256, ext) : null;
}

function formatProjectSummary(row, { includeArchived = false } = {}) {
  const cover = parseJsonValue(row.cover_image);
  const boards = parseJsonValue(row.boards) ?? [];
  const author = formatAuthor(parseJsonValue(row.author));
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    repo_url: row.repo_url ?? null,
    repo_path: row.repo_path ?? null,
    upstream_url: row.upstream_url ?? null,
    tags: parseRowTags(row.tags),
    author,
    ...(includeArchived ? { archived: Boolean(row.archived) } : {}),
    cover_image_url: cover
      ? imageUrlFor(row.id, cover.sha256, cover.content_type)
      : null,
    boards: boards.map((b) => ({
      board_id: b.board_id,
      version: b.version,
      sdk_version: b.sdk_version,
      updated_at: b.updated_at,
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function formatProjectDetail(project, images, boards, author, { includeArchived = false } = {}) {
  const formattedImages = images.map((img) => ({
    position: Number(img.position),
    is_cover: Boolean(img.is_cover),
    content_type: img.content_type,
    size: Number(img.size),
    sha256: img.sha256,
    url: imageUrlFor(project.id, img.sha256, img.content_type),
  }));
  const cover = formattedImages.find((img) => img.is_cover) ?? formattedImages[0] ?? null;
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    repo_url: project.repo_url ?? null,
    repo_path: project.repo_path ?? null,
    upstream_url: project.upstream_url ?? null,
    tags: parseRowTags(project.tags),
    author: formatAuthor(author),
    ...(includeArchived ? { archived: Boolean(project.archived) } : {}),
    cover_image_url: cover ? cover.url : null,
    images: formattedImages,
    boards: boards.map((b) => ({
      board_id: b.board_id,
      version: b.version,
      app_size: Number(b.app_size),
      app_sha256: b.app_sha256,
      app_elf_sha256: b.app_elf_sha256 ?? null,
      sdk_version: b.sdk_version,
      idf_version: b.idf_version ?? null,
      source_revision: b.source_revision ?? null,
      download_url: projectAppUrl(project.id, b.board_id, b.version),
      latest_url: projectAppUrl(project.id, b.board_id),
      created_at: b.created_at,
      updated_at: b.updated_at,
    })),
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
}

function formatRelease(row, promoted) {
  return {
    project_id: row.project_id,
    board_id: row.board_id,
    version: row.version,
    promoted: Boolean(promoted),
    sdk_version: row.sdk_version,
    idf_version: row.idf_version ?? null,
    source_revision: row.source_revision ?? null,
    app: {
      upload_id: row.app_upload_id,
      key: row.app_key,
      size: Number(row.app_size),
      sha256: row.app_sha256,
      elf_sha256: row.app_elf_sha256 ?? null,
      download_url: projectAppUrl(row.project_id, row.board_id, row.version),
    },
    created_at: row.created_at,
  };
}

export async function createUserUploads(env, input) {
  if (!isPlainObject(input)) fail(400, "Expected an upload request object");
  assertAllowedKeys(input, new Set(["files"]));
  if (
    !Array.isArray(input.files) ||
    input.files.length < 1 ||
    input.files.length > maxUserUploads
  )
    fail(400, `files must be an array of 1 to ${maxUserUploads} entries`);

  const specs = input.files.map((entry, index) => {
    if (!isPlainObject(entry)) fail(400, `Invalid files[${index}]`);
    assertAllowedKeys(entry, new Set(["size", "content_type"]), `files[${index}].`);
    if (
      typeof entry.content_type !== "string" ||
      !Object.hasOwn(allowedUploadTypes, entry.content_type)
    )
      fail(400, `Unsupported files[${index}].content_type`);
    const maxSize = allowedUploadTypes[entry.content_type];
    if (!Number.isInteger(entry.size) || entry.size < 1 || entry.size > maxSize)
      fail(400, `Invalid files[${index}].size`);
    return { size: entry.size, contentType: entry.content_type };
  });

  const s3 = r2Config(env);
  const expiresAt = new Date(Date.now() + uploadExpirySeconds * 1000).toISOString();
  const uploads = await Promise.all(
    specs.map(async ({ size, contentType }) => {
      const id = crypto.randomUUID();
      const url = await signPresignedPut(s3, {
        key: stagingKey(id),
        expiresSeconds: uploadExpirySeconds,
        contentType,
        contentLength: size,
      });
      return {
        id,
        method: "PUT",
        url,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(size),
        },
        expires_at: expiresAt,
      };
    }),
  );
  return { uploads };
}

export async function listAuthors(sql) {
  const rows = await sql`SELECT id, name, logo_url, url
    FROM esphub.authors
    ORDER BY id ASC`;
  return rows.map((row) => formatAuthor(row));
}

async function resolveAuthor(sql, authorId) {
  if (!authorId) return null;
  const [author] = await sql`SELECT id, name, logo_url, url
    FROM esphub.authors
    WHERE id = ${authorId}`;
  if (!author) fail(400, "Unknown author_id");
  return author;
}

export async function createProject(sql, owner, input) {
  if (!isPlainObject(input)) fail(400, "Expected a project object");
  assertAllowedKeys(input, createProjectKeys);
  const name = parseName(input.name);
  const description = parseDescription(input.description);
  const repo_url = parseRepoUrl(input.repo_url);
  const repo_path = parseRepoPath(input.repo_path, repo_url);
  const upstream_url = parseUpstreamUrl(input.upstream_url, { defaultNull: true });
  const tags = parseTags(input.tags, { defaultEmpty: true });
  const author_id = parseAuthorId(input.author_id, { defaultNull: true });
  const author = await resolveAuthor(sql, author_id);

  const [project] = await sql`INSERT INTO esphub.projects (
      owner, name, description, repo_url, repo_path, upstream_url, tags, author_id
    ) VALUES (
      ${owner}, ${name}, ${description}, ${repo_url}, ${repo_path}, ${upstream_url},
      ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(tags)}::text::jsonb)),
      ${author_id}
    ) RETURNING id, owner, name, description, repo_url, repo_path, upstream_url,
      to_jsonb(tags) AS tags, author_id, archived, created_at, updated_at`;
  return formatProjectDetail(project, [], [], author, { includeArchived: true });
}

async function fetchProjectDetails(sql, projectId, authorId = null) {
  const [images, boards, authorRows] = await Promise.all([
    sql`SELECT position, is_cover, content_type, size, sha256
      FROM esphub.project_images
      WHERE project_id = ${projectId}
      ORDER BY position ASC`,
    sql`SELECT pb.board_id, pb.latest_version AS version, pb.updated_at,
        r.app_size, r.app_sha256, r.app_elf_sha256,
        r.sdk_version, r.idf_version, r.source_revision, r.created_at
      FROM esphub.project_boards pb
      JOIN esphub.project_releases r
        ON r.project_id = pb.project_id
       AND r.board_id = pb.board_id
       AND r.version = pb.latest_version
      WHERE pb.project_id = ${projectId}
      ORDER BY pb.board_id ASC`,
    authorId
      ? sql`SELECT id, name, logo_url, url FROM esphub.authors WHERE id = ${authorId}`
      : Promise.resolve([]),
  ]);
  return { images, boards, author: authorRows[0] ?? null };
}

export async function listOwnedProjects(sql, owner, { includeArchived = false } = {}) {
  const rows = await sql`SELECT p.id, p.name, p.description, p.repo_url, p.repo_path, p.upstream_url,
      to_jsonb(p.tags) AS tags,
      CASE WHEN a.id IS NOT NULL THEN jsonb_build_object(
        'id', a.id, 'name', a.name, 'logo_url', a.logo_url, 'url', a.url
      ) END AS author,
      p.archived, p.created_at, p.updated_at,
      (SELECT jsonb_build_object('sha256', i.sha256, 'content_type', i.content_type)
       FROM esphub.project_images i
       WHERE i.project_id = p.id
       ORDER BY i.is_cover DESC, i.position ASC
       LIMIT 1) AS cover_image,
      COALESCE(
        (SELECT jsonb_agg(
            jsonb_build_object(
              'board_id', pb.board_id,
              'version', pb.latest_version,
              'sdk_version', r.sdk_version,
              'updated_at', pb.updated_at
            ) ORDER BY pb.board_id
          )
         FROM esphub.project_boards pb
         JOIN esphub.project_releases r
           ON r.project_id = pb.project_id
          AND r.board_id = pb.board_id
          AND r.version = pb.latest_version
         WHERE pb.project_id = p.id),
        '[]'::jsonb
      ) AS boards
    FROM esphub.projects p
    LEFT JOIN esphub.authors a ON a.id = p.author_id
    WHERE p.owner = ${owner}
      AND (${Boolean(includeArchived)}::boolean OR NOT p.archived)
    ORDER BY p.updated_at DESC, p.id ASC`;
  return rows.map((row) => formatProjectSummary(row, { includeArchived: true }));
}

export async function getOwnedProject(sql, owner, rawId) {
  const id = parseProjectId(rawId);
  const [project] =
    await sql`SELECT id, owner, name, description, repo_url, repo_path, upstream_url,
        to_jsonb(tags) AS tags, author_id, archived, created_at, updated_at
      FROM esphub.projects
      WHERE id = ${id} AND owner = ${owner}`;
  if (!project) fail(404, "Project not found");
  const { images, boards, author } = await fetchProjectDetails(sql, id, project.author_id);
  return formatProjectDetail(project, images, boards, author, { includeArchived: true });
}

export function parsePublicProjectsPageParams({
  board,
  vendor,
  soc,
  tag,
  exclude_tag,
  author,
  query = "",
  sort = "recent",
  page,
  limit,
} = {}) {
  let boardFilter = null;
  if (board !== undefined && board !== "") {
    if (typeof board !== "string" || !boardIdPattern.test(board))
      fail(400, "Invalid board");
    boardFilter = board;
  }
  let vendorFilter = null;
  if (vendor !== undefined && vendor !== "") {
    if (typeof vendor !== "string" || !vendorPattern.test(vendor))
      fail(400, "Invalid vendor");
    vendorFilter = vendor;
  }
  let socFilter = null;
  if (soc !== undefined && soc !== "") {
    if (typeof soc !== "string" || !socPattern.test(soc))
      fail(400, "Invalid soc");
    socFilter = soc;
  }
  let tagFilter = null;
  if (tag !== undefined && tag !== "") {
    if (typeof tag !== "string" || tag.length > maxTagLength || !tagPattern.test(tag))
      fail(400, "Invalid tag");
    tagFilter = tag;
  }
  let excludeTagFilter = null;
  if (exclude_tag !== undefined && exclude_tag !== "") {
    if (
      typeof exclude_tag !== "string" ||
      exclude_tag.length > maxTagLength ||
      !tagPattern.test(exclude_tag)
    )
      fail(400, "Invalid exclude_tag");
    excludeTagFilter = exclude_tag;
  }
  let authorFilter = null;
  if (author !== undefined && author !== "") {
    if (typeof author !== "string" || author.length > 64 || !authorIdPattern.test(author))
      fail(400, "Invalid author");
    authorFilter = author;
  }
  if (typeof query !== "string" || query.includes("\0")) fail(400, "Invalid query");
  const needle = query.trim().toLowerCase();

  const sortKey = sort === undefined || sort === "" ? "recent" : sort;
  if (typeof sortKey !== "string" || !allowedProjectSorts.has(sortKey))
    fail(400, "Invalid sort");

  const parseIntParam = (raw, fallback, min, max, label) => {
    if (raw === undefined || raw === "") return fallback;
    const str = typeof raw === "number" ? String(raw) : raw;
    if (typeof str !== "string" || !/^\d+$/.test(str)) fail(400, `Invalid ${label}`);
    const parsed = Number(str);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
      fail(400, `Invalid ${label}`);
    return parsed;
  };

  const pageNum = parseIntParam(page, 1, 1, 100000, "page");
  const limitNum = parseIntParam(
    limit,
    defaultProjectsLimit,
    1,
    maxProjectsLimit,
    "limit",
  );

  return {
    boardFilter,
    vendorFilter,
    socFilter,
    tagFilter,
    excludeTagFilter,
    authorFilter,
    needle,
    sortKey,
    page: pageNum,
    limit: limitNum,
  };
}

export async function listPublicProjectsPage(sql, rawParams = {}) {
  const {
    boardFilter,
    vendorFilter,
    socFilter,
    tagFilter,
    excludeTagFilter,
    authorFilter,
    needle,
    sortKey,
    page,
    limit,
  } = parsePublicProjectsPageParams(rawParams);
  const offset = (page - 1) * limit;

  const [[countRow], rows, vendorFacets, socFacets, tagFacets] = await Promise.all([
    sql`SELECT COUNT(*)::int AS total
      FROM esphub.projects p
      WHERE NOT p.archived
        AND EXISTS (SELECT 1 FROM esphub.project_boards pb WHERE pb.project_id = p.id)
        AND (${boardFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM esphub.project_boards pb
          WHERE pb.project_id = p.id AND pb.board_id = ${boardFilter}
        ))
        AND (${vendorFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM esphub.project_boards pb
          JOIN esphub.boards b ON b.id = pb.board_id
          WHERE pb.project_id = p.id AND b.vendor = ${vendorFilter}
        ))
        AND (${socFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM esphub.project_boards pb
          JOIN esphub.boards b ON b.id = pb.board_id
          WHERE pb.project_id = p.id AND b.soc = ${socFilter}
        ))
        AND (${tagFilter}::text IS NULL OR ${tagFilter}::text = ANY(p.tags))
        AND (${excludeTagFilter}::text IS NULL OR NOT (${excludeTagFilter}::text = ANY(p.tags)))
        AND (${authorFilter}::text IS NULL OR p.author_id = ${authorFilter})
        AND (${needle} = ''
          OR strpos(lower(p.name), ${needle}) > 0
          OR strpos(lower(p.description), ${needle}) > 0
          OR strpos(lower(COALESCE(p.repo_path, '')), ${needle}) > 0
          OR EXISTS (
            SELECT 1 FROM esphub.project_boards pb
            JOIN esphub.boards b ON b.id = pb.board_id
            WHERE pb.project_id = p.id
              AND (
                strpos(lower(pb.board_id), ${needle}) > 0
                OR strpos(lower(b.name), ${needle}) > 0
                OR strpos(lower(b.model), ${needle}) > 0
                OR strpos(lower(b.soc), ${needle}) > 0
              )
          ))`,
    sql`SELECT p.id, p.name, p.description, p.repo_url, p.repo_path, p.upstream_url,
        to_jsonb(p.tags) AS tags,
        CASE WHEN a.id IS NOT NULL THEN jsonb_build_object(
          'id', a.id, 'name', a.name, 'logo_url', a.logo_url, 'url', a.url
        ) END AS author,
        p.created_at, p.updated_at,
        (SELECT jsonb_build_object('sha256', i.sha256, 'content_type', i.content_type)
         FROM esphub.project_images i
         WHERE i.project_id = p.id
         ORDER BY i.is_cover DESC, i.position ASC
         LIMIT 1) AS cover_image,
        COALESCE(
          (SELECT jsonb_agg(
              jsonb_build_object(
                'board_id', pb.board_id,
                'version', pb.latest_version,
                'sdk_version', r.sdk_version,
                'updated_at', pb.updated_at
              ) ORDER BY pb.board_id
            )
           FROM esphub.project_boards pb
           JOIN esphub.project_releases r
             ON r.project_id = pb.project_id
            AND r.board_id = pb.board_id
            AND r.version = pb.latest_version
           WHERE pb.project_id = p.id),
          '[]'::jsonb
        ) AS boards
      FROM esphub.projects p
      LEFT JOIN esphub.authors a ON a.id = p.author_id
      WHERE NOT p.archived
        AND EXISTS (SELECT 1 FROM esphub.project_boards pb WHERE pb.project_id = p.id)
        AND (${boardFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM esphub.project_boards pb
          WHERE pb.project_id = p.id AND pb.board_id = ${boardFilter}
        ))
        AND (${vendorFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM esphub.project_boards pb
          JOIN esphub.boards b ON b.id = pb.board_id
          WHERE pb.project_id = p.id AND b.vendor = ${vendorFilter}
        ))
        AND (${socFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM esphub.project_boards pb
          JOIN esphub.boards b ON b.id = pb.board_id
          WHERE pb.project_id = p.id AND b.soc = ${socFilter}
        ))
        AND (${tagFilter}::text IS NULL OR ${tagFilter}::text = ANY(p.tags))
        AND (${excludeTagFilter}::text IS NULL OR NOT (${excludeTagFilter}::text = ANY(p.tags)))
        AND (${authorFilter}::text IS NULL OR p.author_id = ${authorFilter})
        AND (${needle} = ''
          OR strpos(lower(p.name), ${needle}) > 0
          OR strpos(lower(p.description), ${needle}) > 0
          OR strpos(lower(COALESCE(p.repo_path, '')), ${needle}) > 0
          OR EXISTS (
            SELECT 1 FROM esphub.project_boards pb
            JOIN esphub.boards b ON b.id = pb.board_id
            WHERE pb.project_id = p.id
              AND (
                strpos(lower(pb.board_id), ${needle}) > 0
                OR strpos(lower(b.name), ${needle}) > 0
                OR strpos(lower(b.model), ${needle}) > 0
                OR strpos(lower(b.soc), ${needle}) > 0
              )
          ))
      ORDER BY
        CASE WHEN ${sortKey} = 'boards' THEN (SELECT COUNT(*) FROM esphub.project_boards pb WHERE pb.project_id = p.id) END DESC NULLS LAST,
        CASE WHEN ${sortKey} = 'recent' THEN p.updated_at END DESC NULLS LAST,
        lower(p.name) ASC,
        p.id ASC
      LIMIT ${limit} OFFSET ${offset}`,
    sql`SELECT b.vendor AS id, COUNT(DISTINCT p.id)::int AS count
      FROM esphub.projects p
      JOIN esphub.project_boards pb ON pb.project_id = p.id
      JOIN esphub.boards b ON b.id = pb.board_id
      WHERE NOT p.archived
        AND (${boardFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM esphub.project_boards pb2
          WHERE pb2.project_id = p.id AND pb2.board_id = ${boardFilter}
        ))
        AND (${socFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM esphub.project_boards pb2
          JOIN esphub.boards b2 ON b2.id = pb2.board_id
          WHERE pb2.project_id = p.id AND b2.soc = ${socFilter}
        ))
        AND (${tagFilter}::text IS NULL OR ${tagFilter}::text = ANY(p.tags))
        AND (${excludeTagFilter}::text IS NULL OR NOT (${excludeTagFilter}::text = ANY(p.tags)))
        AND (${authorFilter}::text IS NULL OR p.author_id = ${authorFilter})
        AND (${needle} = ''
          OR strpos(lower(p.name), ${needle}) > 0
          OR strpos(lower(p.description), ${needle}) > 0
          OR strpos(lower(COALESCE(p.repo_path, '')), ${needle}) > 0
          OR EXISTS (
            SELECT 1 FROM esphub.project_boards pb2
            JOIN esphub.boards b2 ON b2.id = pb2.board_id
            WHERE pb2.project_id = p.id
              AND (
                strpos(lower(pb2.board_id), ${needle}) > 0
                OR strpos(lower(b2.name), ${needle}) > 0
                OR strpos(lower(b2.model), ${needle}) > 0
                OR strpos(lower(b2.soc), ${needle}) > 0
              )
          ))
      GROUP BY b.vendor
      ORDER BY count DESC, b.vendor ASC`,
    sql`SELECT b.soc AS id, COUNT(DISTINCT p.id)::int AS count
      FROM esphub.projects p
      JOIN esphub.project_boards pb ON pb.project_id = p.id
      JOIN esphub.boards b ON b.id = pb.board_id
      WHERE NOT p.archived
        AND (${boardFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM esphub.project_boards pb2
          WHERE pb2.project_id = p.id AND pb2.board_id = ${boardFilter}
        ))
        AND (${vendorFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM esphub.project_boards pb2
          JOIN esphub.boards b2 ON b2.id = pb2.board_id
          WHERE pb2.project_id = p.id AND b2.vendor = ${vendorFilter}
        ))
        AND (${tagFilter}::text IS NULL OR ${tagFilter}::text = ANY(p.tags))
        AND (${excludeTagFilter}::text IS NULL OR NOT (${excludeTagFilter}::text = ANY(p.tags)))
        AND (${authorFilter}::text IS NULL OR p.author_id = ${authorFilter})
        AND (${needle} = ''
          OR strpos(lower(p.name), ${needle}) > 0
          OR strpos(lower(p.description), ${needle}) > 0
          OR strpos(lower(COALESCE(p.repo_path, '')), ${needle}) > 0
          OR EXISTS (
            SELECT 1 FROM esphub.project_boards pb2
            JOIN esphub.boards b2 ON b2.id = pb2.board_id
            WHERE pb2.project_id = p.id
              AND (
                strpos(lower(pb2.board_id), ${needle}) > 0
                OR strpos(lower(b2.name), ${needle}) > 0
                OR strpos(lower(b2.model), ${needle}) > 0
                OR strpos(lower(b2.soc), ${needle}) > 0
              )
          ))
      GROUP BY b.soc
      ORDER BY count DESC, b.soc ASC`,
    sql`SELECT t.tag AS id, COUNT(DISTINCT p.id)::int AS count
      FROM esphub.projects p
      CROSS JOIN LATERAL unnest(p.tags) AS t(tag)
      WHERE NOT p.archived
        AND EXISTS (SELECT 1 FROM esphub.project_boards pb WHERE pb.project_id = p.id)
        AND (${boardFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM esphub.project_boards pb2
          WHERE pb2.project_id = p.id AND pb2.board_id = ${boardFilter}
        ))
        AND (${vendorFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM esphub.project_boards pb2
          JOIN esphub.boards b2 ON b2.id = pb2.board_id
          WHERE pb2.project_id = p.id AND b2.vendor = ${vendorFilter}
        ))
        AND (${socFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM esphub.project_boards pb2
          JOIN esphub.boards b2 ON b2.id = pb2.board_id
          WHERE pb2.project_id = p.id AND b2.soc = ${socFilter}
        ))
        AND (${authorFilter}::text IS NULL OR p.author_id = ${authorFilter})
        AND (${needle} = ''
          OR strpos(lower(p.name), ${needle}) > 0
          OR strpos(lower(p.description), ${needle}) > 0
          OR strpos(lower(COALESCE(p.repo_path, '')), ${needle}) > 0
          OR EXISTS (
            SELECT 1 FROM esphub.project_boards pb2
            JOIN esphub.boards b2 ON b2.id = pb2.board_id
            WHERE pb2.project_id = p.id
              AND (
                strpos(lower(pb2.board_id), ${needle}) > 0
                OR strpos(lower(b2.name), ${needle}) > 0
                OR strpos(lower(b2.model), ${needle}) > 0
                OR strpos(lower(b2.soc), ${needle}) > 0
              )
          ))
      GROUP BY t.tag
      ORDER BY count DESC, t.tag ASC`,
  ]);

  const total = Number(countRow?.total ?? 0);
  const total_pages = total === 0 ? 0 : Math.ceil(total / limit);

  return {
    items: rows.map((row) => formatProjectSummary(row)),
    page,
    limit,
    total,
    total_pages,
    facets: {
      vendors: vendorFacets.map((r) => ({ id: r.id, count: Number(r.count) })),
      socs: socFacets.map((r) => ({ id: r.id, count: Number(r.count) })),
      tags: tagFacets.map((r) => ({ id: r.id, count: Number(r.count) })),
    },
  };
}

export async function listPublicProjects(
  sql,
  { board, tag, exclude_tag, author, query = "" } = {},
) {
  const { boardFilter, tagFilter, excludeTagFilter, authorFilter, needle } =
    parsePublicProjectsPageParams({ board, tag, exclude_tag, author, query });

  const rows = await sql`SELECT p.id, p.name, p.description, p.repo_url, p.repo_path, p.upstream_url,
      to_jsonb(p.tags) AS tags,
      CASE WHEN a.id IS NOT NULL THEN jsonb_build_object(
        'id', a.id, 'name', a.name, 'logo_url', a.logo_url, 'url', a.url
      ) END AS author,
      p.created_at, p.updated_at,
      (SELECT jsonb_build_object('sha256', i.sha256, 'content_type', i.content_type)
       FROM esphub.project_images i
       WHERE i.project_id = p.id
       ORDER BY i.is_cover DESC, i.position ASC
       LIMIT 1) AS cover_image,
      COALESCE(
        (SELECT jsonb_agg(
            jsonb_build_object(
              'board_id', pb.board_id,
              'version', pb.latest_version,
              'sdk_version', r.sdk_version,
              'updated_at', pb.updated_at
            ) ORDER BY pb.board_id
          )
         FROM esphub.project_boards pb
         JOIN esphub.project_releases r
           ON r.project_id = pb.project_id
          AND r.board_id = pb.board_id
          AND r.version = pb.latest_version
         WHERE pb.project_id = p.id),
        '[]'::jsonb
      ) AS boards
    FROM esphub.projects p
    LEFT JOIN esphub.authors a ON a.id = p.author_id
    WHERE NOT p.archived
      AND EXISTS (SELECT 1 FROM esphub.project_boards pb WHERE pb.project_id = p.id)
      AND (${boardFilter}::text IS NULL OR EXISTS (
        SELECT 1 FROM esphub.project_boards pb
        WHERE pb.project_id = p.id AND pb.board_id = ${boardFilter}
      ))
      AND (${tagFilter}::text IS NULL OR ${tagFilter}::text = ANY(p.tags))
      AND (${excludeTagFilter}::text IS NULL OR NOT (${excludeTagFilter}::text = ANY(p.tags)))
      AND (${authorFilter}::text IS NULL OR p.author_id = ${authorFilter})
      AND (${needle} = ''
        OR strpos(lower(p.name), ${needle}) > 0
        OR strpos(lower(p.description), ${needle}) > 0)
    ORDER BY p.updated_at DESC, p.id ASC`;
  return rows.map((row) => formatProjectSummary(row));
}

export async function getPublicProject(sql, rawId) {
  const id = parseProjectId(rawId);
  const [project] = await sql`SELECT p.id, p.owner, p.name, p.description, p.repo_url,
      p.repo_path, p.upstream_url, to_jsonb(p.tags) AS tags, p.author_id, p.archived,
      p.created_at, p.updated_at
    FROM esphub.projects p
    WHERE p.id = ${id}
      AND NOT p.archived
      AND EXISTS (SELECT 1 FROM esphub.project_boards pb WHERE pb.project_id = p.id)`;
  if (!project) fail(404, "Project not found");
  const { images, boards, author } = await fetchProjectDetails(sql, id, project.author_id);
  return formatProjectDetail(project, images, boards, author);
}

export async function getProjectForMcp(sql, owner, rawId) {
  const id = parseProjectId(rawId);
  const [project] = await sql`SELECT id, owner, name, description, repo_url, repo_path,
      upstream_url, to_jsonb(tags) AS tags, author_id, archived, created_at, updated_at
    FROM esphub.projects
    WHERE id = ${id}`;
  if (!project) fail(404, "Project not found");
  const isOwner = owner !== undefined && project.owner === owner;
  const { images, boards, author } = await fetchProjectDetails(sql, id, project.author_id);
  if (isOwner) return formatProjectDetail(project, images, boards, author, { includeArchived: true });
  if (project.archived || boards.length === 0) fail(404, "Project not found");
  return formatProjectDetail(project, images, boards, author);
}

export async function updateProject(env, sql, owner, rawId, input) {
  const id = parseProjectId(rawId);
  if (!isPlainObject(input)) fail(400, "Expected a project update object");
  assertAllowedKeys(input, updateProjectKeys);

  const name = parseName(input.name);
  const description = parseDescription(input.description);
  const repo_url = parseRepoUrl(input.repo_url);
  const repo_path = parseRepoPath(input.repo_path, repo_url);
  const parsedUpstreamUrl = parseUpstreamUrl(input.upstream_url);
  const parsedTags = parseTags(input.tags);
  const parsedAuthorId = parseAuthorId(input.author_id);
  const hasImages = input.images !== undefined;

  const [existingProject] =
    await sql`SELECT id, owner, name, description, repo_url, repo_path, upstream_url,
        to_jsonb(tags) AS tags, author_id, archived, created_at, updated_at
      FROM esphub.projects
      WHERE id = ${id} AND owner = ${owner}`;
  if (!existingProject) fail(404, "Project not found");
  if (existingProject.archived) fail(409, "Project is archived");

  const nextUpstreamUrl =
    parsedUpstreamUrl !== undefined ? parsedUpstreamUrl : existingProject.upstream_url;
  const nextTags =
    parsedTags !== undefined ? parsedTags : parseRowTags(existingProject.tags);
  const nextAuthorId =
    parsedAuthorId !== undefined ? parsedAuthorId : existingProject.author_id;
  if (parsedAuthorId !== undefined && nextAuthorId !== null) {
    await resolveAuthor(sql, nextAuthorId);
  }

  if (!hasImages) {
    const [updated] = await sql`UPDATE esphub.projects
      SET name = ${name}, description = ${description},
          repo_url = ${repo_url}, repo_path = ${repo_path},
          upstream_url = ${nextUpstreamUrl},
          tags = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(nextTags)}::text::jsonb)),
          author_id = ${nextAuthorId},
          updated_at = now()
      WHERE id = ${id} AND owner = ${owner} AND NOT archived
      RETURNING id, owner, name, description, repo_url, repo_path, upstream_url,
        to_jsonb(tags) AS tags, author_id, archived, created_at, updated_at`;
    if (!updated) fail(404, "Project not found");
    const { images, boards, author } = await fetchProjectDetails(sql, id, updated.author_id);
    return formatProjectDetail(updated, images, boards, author, { includeArchived: true });
  }

  if (!Array.isArray(input.images) || input.images.length > maxProjectImages)
    fail(400, `images must be an array of at most ${maxProjectImages} entries`);

  const currentImages = await sql`SELECT position, is_cover, object_key, content_type, size, sha256, upload_id
    FROM esphub.project_images
    WHERE project_id = ${id}
    ORDER BY position ASC`;
  const existingBySha = new Map(currentImages.map((img) => [img.sha256, img]));

  const seenSha = new Set();
  const seenUploads = new Set();
  let coverCount = 0;
  const plan = input.images.map((entry, index) => {
    if (!isPlainObject(entry)) fail(400, `Invalid images[${index}]`);
    assertAllowedKeys(entry, imageInputKeys, `images[${index}].`);
    if (typeof entry.sha256 !== "string" || !sha256Pattern.test(entry.sha256))
      fail(400, `Invalid images[${index}].sha256`);
    if (seenSha.has(entry.sha256)) fail(400, "Duplicate image sha256");
    seenSha.add(entry.sha256);

    const isCover = entry.is_cover === undefined ? false : entry.is_cover;
    if (typeof isCover !== "boolean") fail(400, `Invalid images[${index}].is_cover`);
    if (isCover) coverCount++;

    const current = existingBySha.get(entry.sha256);
    if (entry.upload_id === undefined) {
      if (!current) fail(400, `Unknown existing image sha256 at images[${index}]`);
      if (entry.size !== undefined && entry.size !== Number(current.size))
        fail(400, `Image size mismatch at images[${index}]`);
      if (
        entry.content_type !== undefined &&
        entry.content_type !== current.content_type
      )
        fail(400, `Image content_type mismatch at images[${index}]`);
      return {
        mode: "keep",
        index,
        position: index,
        is_cover: isCover,
        object_key: current.object_key,
        content_type: current.content_type,
        size: Number(current.size),
        sha256: current.sha256,
        upload_id: current.upload_id,
      };
    }

    if (typeof entry.upload_id !== "string" || !uuidPattern.test(entry.upload_id))
      fail(400, `Invalid images[${index}].upload_id`);
    if (seenUploads.has(entry.upload_id)) fail(400, "Duplicate upload_id across images");
    seenUploads.add(entry.upload_id);

    if (
      typeof entry.content_type !== "string" ||
      !Object.hasOwn(imageExtensions, entry.content_type)
    )
      fail(400, `Unsupported images[${index}].content_type`);
    if (
      !Number.isInteger(entry.size) ||
      entry.size < 1 ||
      entry.size > maxImageBytes
    )
      fail(400, `Invalid images[${index}].size`);

    if (current) {
      if (
        Number(current.size) !== entry.size ||
        current.content_type !== entry.content_type
      )
        fail(409, `Image sha256 already exists with different metadata at images[${index}]`);
      return {
        mode: "reuse_or_stage",
        index,
        position: index,
        is_cover: isCover,
        object_key: current.object_key,
        content_type: current.content_type,
        size: entry.size,
        sha256: entry.sha256,
        upload_id: entry.upload_id,
        fallback_upload_id: current.upload_id,
      };
    }

    const ext = imageExtensions[entry.content_type];
    return {
      mode: "new",
      index,
      position: index,
      is_cover: isCover,
      object_key: projectImageObjectKey(id, entry.sha256, ext),
      content_type: entry.content_type,
      size: entry.size,
      sha256: entry.sha256,
      upload_id: entry.upload_id,
    };
  });

  if (coverCount > 1) fail(400, "At most one cover image allowed");
  if (plan.length > 0 && coverCount === 0) plan[0].is_cover = true;

  const stagedToCleanup = [];
  const toCopy = [];
  await Promise.all(
    plan.map(async (item) => {
      if (item.mode === "keep") return;
      const srcKey = stagingKey(item.upload_id);
      const head = await env.FIRMWARE.head(srcKey);
      if (!head) {
        if (item.mode === "reuse_or_stage") {
          item.upload_id = item.fallback_upload_id;
          return;
        }
        fail(400, `Staging upload not found: images[${item.index}]`);
      }
      if (head.size !== item.size)
        fail(400, `Staging upload size mismatch: images[${item.index}]`);
      if (
        head.httpMetadata?.contentType &&
        head.httpMetadata.contentType !== item.content_type
      )
        fail(400, `Staging upload content_type mismatch: images[${item.index}]`);
      stagedToCleanup.push(srcKey);
      if (item.mode === "new") toCopy.push({ item, srcKey });
    }),
  );

  if (toCopy.length > 0) {
    const s3 = r2Config(env);
    await Promise.all(
      toCopy.map(({ item, srcKey }) =>
        copyStagedObject(env, s3, {
          label: `images[${item.index}]`,
          srcKey,
          destKey: item.object_key,
          contentType: item.content_type,
          expectedSize: item.size,
          expectedSha: item.sha256,
        }),
      ),
    );
  }

  const rowsToInsert = plan.map((item) => ({
    position: item.position,
    is_cover: item.is_cover,
    object_key: item.object_key,
    content_type: item.content_type,
    size: item.size,
    sha256: item.sha256,
    upload_id: item.upload_id,
  }));

  const [updatedRows] = await inTransaction(sql, (tx) => {
    const queries = [
      tx`UPDATE esphub.projects
        SET name = ${name}, description = ${description},
            repo_url = ${repo_url}, repo_path = ${repo_path},
            upstream_url = ${nextUpstreamUrl},
            tags = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(nextTags)}::text::jsonb)),
            author_id = ${nextAuthorId},
            updated_at = now()
        WHERE id = ${id} AND owner = ${owner} AND NOT archived
        RETURNING id, owner, name, description, repo_url, repo_path, upstream_url,
          to_jsonb(tags) AS tags, author_id, archived, created_at, updated_at`,
      tx`DELETE FROM esphub.project_images
        WHERE project_id = ${id}
          AND EXISTS (
            SELECT 1 FROM esphub.projects
            WHERE id = ${id} AND owner = ${owner} AND NOT archived
          )`,
    ];
    if (rowsToInsert.length > 0) {
      queries.push(
        tx`INSERT INTO esphub.project_images (
            project_id, position, is_cover, object_key, content_type, size, sha256, upload_id
          )
          SELECT ${id}::uuid, x.position, x.is_cover, x.object_key, x.content_type, x.size, x.sha256, x.upload_id
          FROM jsonb_to_recordset(${JSON.stringify(rowsToInsert)}::text::jsonb) AS x(
            position integer,
            is_cover boolean,
            object_key text,
            content_type text,
            size integer,
            sha256 text,
            upload_id uuid
          )
          WHERE EXISTS (
            SELECT 1 FROM esphub.projects
            WHERE id = ${id} AND owner = ${owner} AND NOT archived
          )`,
      );
    }
    return queries;
  });

  if (!updatedRows?.[0]) fail(404, "Project not found");

  const nextKeys = new Set(rowsToInsert.map((item) => item.object_key));
  const removedKeys = currentImages
    .map((img) => img.object_key)
    .filter((key) => !nextKeys.has(key));
  const toDelete = [...stagedToCleanup, ...removedKeys];
  if (toDelete.length > 0) await env.FIRMWARE.delete(toDelete).catch(() => {});

  const { images, boards, author } = await fetchProjectDetails(sql, id, updatedRows[0].author_id);
  return formatProjectDetail(updatedRows[0], images, boards, author, { includeArchived: true });
}

function parseReleasePayload(projectId, input) {
  if (!isPlainObject(input)) fail(400, "Expected a release request object");
  assertAllowedKeys(input, releaseKeys);

  if (typeof input.board_id !== "string" || !boardIdPattern.test(input.board_id))
    fail(400, "Invalid board_id");
  if (typeof input.version !== "string" || !versionPattern.test(input.version))
    fail(400, "Invalid version");
  const sdk_version = parseOptionalLabel(input.sdk_version, "sdk_version", 64);
  if (!sdk_version) fail(400, "Invalid sdk_version");
  const idf_version = parseOptionalLabel(input.idf_version, "idf_version", 64);

  let source_revision = null;
  if (input.source_revision !== undefined && input.source_revision !== null) {
    if (
      typeof input.source_revision !== "string" ||
      !revisionPattern.test(input.source_revision)
    )
      fail(400, "Invalid source_revision");
    source_revision = input.source_revision;
  }

  let promote = true;
  if (input.promote !== undefined) {
    if (typeof input.promote !== "boolean") fail(400, "Invalid promote");
    promote = input.promote;
  }

  if (!isPlainObject(input.app)) fail(400, "Missing app");
  assertAllowedKeys(input.app, releaseAppKeys, "app.");
  if (
    typeof input.app.upload_id !== "string" ||
    !uuidPattern.test(input.app.upload_id)
  )
    fail(400, "Invalid app.upload_id");
  if (
    !Number.isInteger(input.app.size) ||
    input.app.size < 1 ||
    input.app.size > maxFlashBytes
  )
    fail(400, "Invalid app.size");
  if (typeof input.app.sha256 !== "string" || !sha256Pattern.test(input.app.sha256))
    fail(400, "Invalid app.sha256");

  let app_elf_sha256 = null;
  if (input.app.elf_sha256 !== undefined && input.app.elf_sha256 !== null) {
    if (
      typeof input.app.elf_sha256 !== "string" ||
      !sha256Pattern.test(input.app.elf_sha256)
    )
      fail(400, "Invalid app.elf_sha256");
    app_elf_sha256 = input.app.elf_sha256;
  }

  return {
    promote,
    row: {
      project_id: projectId,
      board_id: input.board_id,
      version: input.version,
      app_key: projectReleaseObjectKey(projectId, input.board_id, input.version),
      app_size: input.app.size,
      app_sha256: input.app.sha256,
      app_elf_sha256,
      app_upload_id: input.app.upload_id,
      sdk_version,
      idf_version,
      source_revision,
    },
  };
}

function releaseMatches(existing, candidate) {
  const fields = [
    "app_key",
    "app_size",
    "app_sha256",
    "app_elf_sha256",
    "sdk_version",
    "idf_version",
    "source_revision",
  ];
  for (const field of fields) {
    const a = existing[field] === null || existing[field] === undefined ? null : String(existing[field]);
    const b = candidate[field] === null || candidate[field] === undefined ? null : String(candidate[field]);
    if (a !== b) return false;
  }
  return true;
}

async function isCurrentRelease(sql, projectId, boardId, version) {
  const [boardRow] =
    await sql`SELECT latest_version FROM esphub.project_boards WHERE project_id = ${projectId} AND board_id = ${boardId}`;
  return boardRow?.latest_version === version;
}

export async function createProjectRelease(env, sql, owner, rawId, input) {
  const projectId = parseProjectId(rawId);
  const { promote, row } = parseReleasePayload(projectId, input);

  const [project] =
    await sql`SELECT id, archived FROM esphub.projects WHERE id = ${projectId} AND owner = ${owner}`;
  if (!project) fail(404, "Project not found");
  if (project.archived) fail(409, "Project is archived");

  const [board] =
    await sql`SELECT id, flash_mb, retired FROM esphub.boards WHERE id = ${row.board_id}`;
  if (!board) fail(404, "Unknown board");
  if (board.retired) fail(400, "Board is retired");
  if (row.app_size > Number(board.flash_mb) * 1024 * 1024)
    fail(400, "App binary exceeds board flash size");

  const [existing] = await sql`SELECT * FROM esphub.project_releases
    WHERE project_id = ${projectId} AND board_id = ${row.board_id} AND version = ${row.version}`;
  if (existing) {
    if (releaseMatches(existing, row)) {
      const promoted = await isCurrentRelease(sql, projectId, row.board_id, row.version);
      return { status: 200, body: formatRelease(existing, promoted) };
    }
    fail(409, "Project release already exists with different content");
  }

  const s3 = r2Config(env);
  const srcKey = stagingKey(row.app_upload_id);
  const head = await env.FIRMWARE.head(srcKey);
  if (!head) fail(400, "Staging upload not found: app");
  if (head.size !== row.app_size) fail(400, "Staging upload size mismatch: app");
  if (
    head.httpMetadata?.contentType &&
    head.httpMetadata.contentType !== "application/octet-stream"
  )
    fail(400, "Staging upload content_type mismatch: app");

  await copyStagedObject(env, s3, {
    label: "app",
    srcKey,
    destKey: row.app_key,
    contentType: "application/octet-stream",
    expectedSize: row.app_size,
    expectedSha: row.app_sha256,
  });

  const [inserted] = await sql`WITH ins AS (
      INSERT INTO esphub.project_releases (
        project_id, board_id, version,
        app_key, app_size, app_sha256, app_elf_sha256, app_upload_id,
        sdk_version, idf_version, source_revision
      ) VALUES (
        ${row.project_id}, ${row.board_id}, ${row.version},
        ${row.app_key}, ${row.app_size}, ${row.app_sha256}, ${row.app_elf_sha256}, ${row.app_upload_id},
        ${row.sdk_version}, ${row.idf_version}, ${row.source_revision}
      )
      ON CONFLICT (project_id, board_id, version) DO NOTHING
      RETURNING *
    ),
    pb AS (
      INSERT INTO esphub.project_boards (project_id, board_id, latest_version, updated_at)
      SELECT project_id, board_id, version, now()
      FROM ins
      WHERE ${promote}::boolean
      ON CONFLICT (project_id, board_id) DO UPDATE
        SET latest_version = EXCLUDED.latest_version, updated_at = now()
    ),
    touch AS (
      UPDATE esphub.projects
      SET updated_at = now()
      WHERE id = (SELECT project_id FROM ins)
    )
    SELECT * FROM ins`;

  if (!inserted) {
    const [raced] = await sql`SELECT * FROM esphub.project_releases
      WHERE project_id = ${projectId} AND board_id = ${row.board_id} AND version = ${row.version}`;
    if (raced && releaseMatches(raced, row)) {
      await env.FIRMWARE.delete(srcKey).catch(() => {});
      const promoted = await isCurrentRelease(sql, projectId, row.board_id, row.version);
      return { status: 200, body: formatRelease(raced, promoted) };
    }
    fail(409, "Project release already exists with different content");
  }

  await env.FIRMWARE.delete(srcKey).catch(() => {});
  return { status: 201, body: formatRelease(inserted, promote) };
}

export async function setCurrentProjectBoardRelease(sql, owner, rawId, boardId, input) {
  const projectId = parseProjectId(rawId);
  if (typeof boardId !== "string" || !boardIdPattern.test(boardId))
    fail(400, "Invalid board ID");
  if (!isPlainObject(input)) fail(400, "Expected a release request object");
  assertAllowedKeys(input, new Set(["version"]));
  if (typeof input.version !== "string" || !versionPattern.test(input.version))
    fail(400, "Invalid version");

  const [project] =
    await sql`SELECT id, archived FROM esphub.projects WHERE id = ${projectId} AND owner = ${owner}`;
  if (!project) fail(404, "Project not found");
  if (project.archived) fail(409, "Project is archived");

  const [target] = await sql`SELECT version FROM esphub.project_releases
    WHERE project_id = ${projectId} AND board_id = ${boardId} AND version = ${input.version}`;
  if (!target) fail(404, "Project release not found");

  const [row] = await sql`WITH pb AS (
      INSERT INTO esphub.project_boards (project_id, board_id, latest_version, updated_at)
      VALUES (${projectId}, ${boardId}, ${input.version}, now())
      ON CONFLICT (project_id, board_id) DO UPDATE
        SET latest_version = EXCLUDED.latest_version, updated_at = now()
      RETURNING project_id, board_id, latest_version, updated_at
    ),
    touch AS (
      UPDATE esphub.projects SET updated_at = now() WHERE id = ${projectId}
    )
    SELECT * FROM pb`;
  return {
    project_id: row.project_id,
    board_id: row.board_id,
    version: row.latest_version,
    download_url: projectAppUrl(projectId, boardId, row.latest_version),
    latest_url: projectAppUrl(projectId, boardId),
    updated_at: row.updated_at,
  };
}

export async function removeProjectBoard(sql, owner, rawId, boardId) {
  const projectId = parseProjectId(rawId);
  if (typeof boardId !== "string" || !boardIdPattern.test(boardId))
    fail(404, "Board not linked to project");
  const [project] =
    await sql`SELECT id, archived FROM esphub.projects WHERE id = ${projectId} AND owner = ${owner}`;
  if (!project) fail(404, "Project not found");
  if (project.archived) fail(409, "Project is archived");

  const [deleted] = await sql`WITH del AS (
      DELETE FROM esphub.project_boards
      WHERE project_id = ${projectId} AND board_id = ${boardId}
      RETURNING project_id, board_id
    ),
    touch AS (
      UPDATE esphub.projects
      SET updated_at = now()
      WHERE id = (SELECT project_id FROM del)
    )
    SELECT * FROM del`;
  if (!deleted) fail(404, "Board not linked to project");
  return { project_id: projectId, board_id: boardId, removed: true };
}

export async function archiveProject(sql, owner, rawId) {
  const projectId = parseProjectId(rawId);
  const [row] = await sql`UPDATE esphub.projects
    SET archived = true, updated_at = now()
    WHERE id = ${projectId} AND owner = ${owner}
    RETURNING id, archived, updated_at`;
  if (!row) fail(404, "Project not found");
  return { id: row.id, archived: Boolean(row.archived), updated_at: row.updated_at };
}

export async function projectAppFile(sql, rawId, boardId, version) {
  if (
    typeof rawId !== "string" ||
    !uuidInsensitive.test(rawId) ||
    typeof boardId !== "string" ||
    !boardIdPattern.test(boardId) ||
    (version !== undefined &&
      (typeof version !== "string" || !versionPattern.test(version)))
  )
    fail(404, "Unknown project release");
  const projectId = rawId.toLowerCase();
  const [row] =
    version === undefined
      ? await sql`SELECT r.project_id, r.board_id, r.version, r.app_key, r.app_size, r.app_sha256
          FROM esphub.projects p
          JOIN esphub.project_boards pb ON pb.project_id = p.id
          JOIN esphub.project_releases r
            ON r.project_id = pb.project_id
           AND r.board_id = pb.board_id
           AND r.version = pb.latest_version
          WHERE p.id = ${projectId} AND NOT p.archived AND pb.board_id = ${boardId}`
      : await sql`SELECT r.project_id, r.board_id, r.version, r.app_key, r.app_size, r.app_sha256
          FROM esphub.projects p
          JOIN esphub.project_releases r ON r.project_id = p.id
          WHERE p.id = ${projectId} AND NOT p.archived AND r.board_id = ${boardId} AND r.version = ${version}`;
  if (!row) fail(404, "Unknown project release");
  return { ...row, app_size: Number(row.app_size) };
}

export async function projectAppResponse(sql, bucket, rawId, boardId, version) {
  const file = await projectAppFile(sql, rawId, boardId, version);
  const object = await bucket.get(file.app_key);
  if (!object) fail(503, "Published project app unavailable");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  headers.set(
    "Cache-Control",
    version === undefined
      ? "public, max-age=0, must-revalidate"
      : "public, max-age=31536000, immutable",
  );
  return new Response(object.body, { headers });
}

const projectAppBase = apiOrigin + "/projects/";
export function parseProjectAppUrl(url) {
  if (typeof url !== "string" || !url.startsWith(projectAppBase)) return null;
  const parsed = new URL(url);
  if (parsed.origin !== apiOrigin || parsed.search || parsed.hash)
    fail(400, "Invalid project app URL");
  const segments = parsed.pathname.split("/").filter(Boolean);
  // /projects/:id/boards/:vendor/:slug/app
  if (segments.length === 6 && segments[0] === "projects" && segments[2] === "boards" && segments[5] === "app") {
    const projectId = segments[1];
    const boardId = `${segments[3]}/${segments[4]}`;
    if (!uuidInsensitive.test(projectId) || !boardIdPattern.test(boardId))
      fail(400, "Invalid project app URL");
    return { projectId: projectId.toLowerCase(), boardId, version: undefined };
  }
  // /projects/:id/boards/:vendor/:slug/releases/:version/app
  if (
    segments.length === 8 &&
    segments[0] === "projects" &&
    segments[2] === "boards" &&
    segments[5] === "releases" &&
    segments[7] === "app"
  ) {
    const projectId = segments[1];
    const boardId = `${segments[3]}/${segments[4]}`;
    const version = decodeURIComponent(segments[6]);
    if (
      !uuidInsensitive.test(projectId) ||
      !boardIdPattern.test(boardId) ||
      !versionPattern.test(version)
    )
      fail(400, "Invalid project app URL");
    return { projectId: projectId.toLowerCase(), boardId, version };
  }
  fail(400, "Invalid project app URL");
}
