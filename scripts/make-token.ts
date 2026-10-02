// Usage: npm run token -- <userId>
// Prints a bearer token for that user, signed with AUTH_TOKEN_SECRET.
// There's no signup/login flow in this exercise's scope — this is how a
// client gets a token to test with.

import { signToken } from "../src/middlewares/auth";

const userId = process.argv[2];
if (!userId) {
  // eslint-disable-next-line no-console
  console.error("Usage: npm run token -- <userId>");
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log(signToken(userId));
