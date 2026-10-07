import { testUrl } from "./db-urls";

process.env.DATABASE_URL = testUrl();
process.env.SUITE_SECRET_KEY = "test-secret-key-for-unit-tests-only-0123456789";
process.env.SUITE_URL = "https://suite.test";
process.env.SUITE_SETUP_CODE = "";
