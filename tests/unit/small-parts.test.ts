import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import { signRequest } from "@/lib/s3-sigv4.mjs";

describe("S3 Signature Version 4", () => {
  // AWS's published example: "Example: GET Object" in the S3 API reference
  // (Authenticating Requests: Using the Authorization Header, Signature V4).
  it("matches AWS's own example signature", () => {
    const headers = signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      headers: { range: "bytes=0-9" },
      payloadHash: createHash("sha256").update("").digest("hex"),
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});

describe("CSV import reader", () => {
  it("reads quoted fields, doubled quotes, commas and newlines inside quotes", () => {
    const { header, rows } = parseCsv('﻿Title, Body ,key\r\n"Hello, all","Line one\nLine ""two""",k1\n\nPlain,Text,k2\n');
    expect(header).toEqual(["title", "body", "key"]);
    expect(rows).toEqual([
      { title: "Hello, all", body: 'Line one\nLine "two"', key: "k1" },
      { title: "Plain", body: "Text", key: "k2" },
    ]);
  });

  it("gives missing cells as empty strings and handles no trailing newline", () => {
    expect(parseCsv("a,b\n1").rows).toEqual([{ a: "1", b: "" }]);
    expect(parseCsv("").rows).toEqual([]);
  });
});
