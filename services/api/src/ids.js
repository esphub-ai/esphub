// Canonical lowercase UUID, as Postgres and Durable Object names use it.
export const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
