import {expect,it} from "vitest";
import {buildApiApp} from "./app.js";
it("permits original key and expected actor headers for the configured authenticated browser origin",async()=>{
  const app=await buildApiApp({env:{NODE_ENV:"test"},corsOrigin:"https://web.example.test"});
  try {
    const response=await app.inject({method:"OPTIONS",url:"/api/v1/projects/project-a/databases/orders/runtime/backup",headers:{origin:"https://web.example.test","access-control-request-method":"POST","access-control-request-headers":"content-type,idempotency-key,x-deploylite-expected-actor-id"}});
    expect(response.statusCode).toBe(204);expect(response.headers["access-control-allow-origin"]).toBe("https://web.example.test");
    const headers=String(response.headers["access-control-allow-headers"]).split(",");
    expect(headers).toContain("idempotency-key");expect(headers).toContain("x-deploylite-expected-actor-id");
    const foreign=await app.inject({method:"OPTIONS",url:"/api/v1/projects/project-a/databases/orders/backups",headers:{origin:"https://foreign.example.test","access-control-request-method":"GET","access-control-request-headers":"x-deploylite-expected-actor-id"}});
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();expect(foreign.headers["access-control-allow-headers"]).toBeUndefined();
  } finally {await app.close();}
});
