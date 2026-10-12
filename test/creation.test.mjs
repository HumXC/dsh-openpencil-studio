import test from "node:test";
import assert from "node:assert/strict";
import {planCreation, preserveCreation} from "../lib/creation.js";
import {callNative, TECHNICAL_CATALOG} from "../lib/native.js";

test("bounded QuickJS captures helper values and kit overrides using opaque parents",async()=>{
 const p=await planCreation(`function makeRows(parent){for(let i=0;i<2;i++)I(parent,{type:"text",content:"C() U() "+i,fill:[{type:"solid",color:"#111111"}]});} const frame=I(null,{type:"frame",width:300,height:220});makeRows(frame);K("optional-component",frame,{name:"Chosen component",width:90});`);
 assert.equal(p.inserts.length,4);assert.equal(p.inserts[1].parent,p.inserts[0].binding);assert.equal(p.inserts[3].kit,"optional-component");assert.equal(p.inserts[3].node.width,90);assert.ok(p.script.includes('K("optional-component",studioInsert0,'));
 for(const source of ['process.exit()','require("node:fs")','fetch("https://example.com")'])await assert.rejects(planCreation(source),e=>e.code==="SCRIPT_EXECUTION"&&e.details.committed===false);
 await assert.rejects(planCreation(`I(null,{type:"frame",id:"fake"})`),e=>e.code==="NODE_ID_FORBIDDEN");
 await assert.rejects(planCreation("while(true){}"),e=>e.code==="SCRIPT_EXECUTION");assert.equal((await planCreation('I(null,{type:"frame",width:20,height:20})')).inserts.length,1);
});
test("unsupported JSON batches cannot bypass neutral creation; existing fields and new IDs survive restoration",async()=>{
 const schema=TECHNICAL_CATALOG.find(t=>t.name==="batch_design").inputSchema;assert.equal("nodes_json"in schema.properties,false);await assert.rejects(callNative({},"batch_design",{nodes_json:"[]"}),e=>e.code==="INVALID_BATCH_INPUT"&&e.details.committed===false);
 const plan=await planCreation(`I(null,{type:"text",height:32,fill:[{type:"solid",color:"#111111"}]})`);const before={children:[{id:"old",type:"text",fontSize:17}]};const after={children:[{id:"old",type:"text",fontSize:20},{id:"new",type:"text",height:"fit_content",fill:[{type:"solid",color:"#FFFFFF"}]}]};assert.equal(preserveCreation(before,after,plan,{results:[{binding:"b0",nodeId:"new"}]}),true);assert.equal(after.children[0].fontSize,17);assert.equal(after.children[1].id,"new");assert.equal(after.children[1].height,32);assert.equal(after.children[1].fill[0].color,"#111111");
});
