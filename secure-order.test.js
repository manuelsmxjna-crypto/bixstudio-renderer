import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyShopifyWebhook, readPaidDrafts, validateSecureSheet } from "./secure-order.js";

const projectId = "d1e9189a-1acf-4c13-9fc7-844c4140479b";
const draftId = "700c778a-4cec-4d3c-8a9f-bf9de4d220bb";

test("webhook signature must match the raw bytes", () => {
  const body = Buffer.from('{"id":123,"financial_status":"paid"}');
  const signature = crypto.createHmac("sha256", "secret").update(body).digest("base64");
  assert.equal(verifyShopifyWebhook(body, signature, "secret"), true);
  assert.equal(verifyShopifyWebhook(Buffer.from(body.toString()+" "), signature, "secret"), false);
});

test("only paid matching lines provide draft IDs", () => {
  const order = {financial_status:"paid",line_items:[{variant_id:52961074610357,quantity:42,properties:[{name:"_BixStudio Draft IDs",value:draftId}]}]};
  assert.deepEqual(readPaidDrafts(order, 52961074610357), [{ids:[draftId],quantity:42}]);
  assert.deepEqual(readPaidDrafts({...order,financial_status:"pending"},52961074610357), []);
  assert.throws(()=>readPaidDrafts({...order,line_items:[...order.line_items,...order.line_items]},52961074610357));
});

test("draft accepts gallery references but rejects other project paths", () => {
  const sheet={widthCm:62,heightCm:42};
  assert.equal(validateSecureSheet(sheet,[{galleryId:"abcd1234",x:0,y:0,width:10,height:10}],projectId),42);
  assert.throws(()=>validateSecureSheet(sheet,[{storagePath:"projects/other/assets/originals/a.png",x:0,y:0,width:10,height:10}],projectId));
  assert.throws(()=>validateSecureSheet(sheet,[{galleryId:"abcd1234",storagePath:`projects/${projectId}/assets/originals/a.png`,x:0,y:0,width:10,height:10}],projectId));
});
