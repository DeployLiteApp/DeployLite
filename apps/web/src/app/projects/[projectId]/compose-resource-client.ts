import { z } from "zod";
import { COMPOSE_PREVIEW_MAX_BYTES,composeAttachmentPreviewInputSchema,composeAttachmentPreviewSchema,composeNetworkAttachmentCommandInputSchema,composeNetworkAttachmentReceiptSchema,composeResourceInspectionInputSchema,composeResourceInspectionViewSchema,
  type ComposeAttachmentPreviewInput,type ComposeAttachmentPreviewV1,type ComposeNetworkAttachmentCommandInput,type ComposeNetworkAttachmentReceiptV1,type ComposeResourceInspectionInput,type ComposeResourceInspectionViewV1 } from "@deploylite/contracts";

type Transport={apiBaseUrl:string|null;fetchImpl?:typeof fetch;signal?:AbortSignal};
export type InspectionOptions=ComposeResourceInspectionInput&Transport;
export type AttachmentOptions=ComposeAttachmentPreviewInput&Transport;
type Failure={kind:"error";message:string};
export type InspectionResult={kind:"ready";inspection:ComposeResourceInspectionViewV1}|Failure;
export type AttachmentResult={kind:"ready";preview:ComposeAttachmentPreviewV1}|Failure;
export type NetworkAttachmentOptions=ComposeNetworkAttachmentCommandInput&Transport&Readonly<{idempotencyKey:string}>;
export type NetworkAttachmentResult={kind:"ready";receipt:ComposeNetworkAttachmentReceiptV1}|Failure&Readonly<{retryable:boolean}>;
const failed=(message:string):Failure=>({kind:"error",message});
const invalidInspection=()=>failed("The API returned an invalid resource observation.");
const invalidAttachment=()=>failed("The API returned an invalid attachment preview.");
const inspectionEnvelope=z.object({data:z.object({inspection:composeResourceInspectionViewSchema}).strict(),error:z.null(),requestId:z.string().min(1).max(200)}).strict();
const attachmentEnvelope=z.object({data:z.object({preview:composeAttachmentPreviewSchema}).strict(),error:z.null(),requestId:z.string().min(1).max(200)}).strict();
const networkAttachmentEnvelope=z.object({data:z.object({attachment:composeNetworkAttachmentReceiptSchema}).strict(),error:z.null(),requestId:z.string().min(1).max(200)}).strict();
function configured(value:string|null):URL|null{
  try {const url=new URL(value??"");return ["http:","https:"].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash?url:null;}catch{return null;}
}
function statusMessage(status:number):string{
  return status===401?"Sign in again to inspect project resources.":status===403?"Resource inspection requires project deploy permission.":status===404?"This project is unavailable.":status===409?"The resource changed or is in use. Inspect it again.":"Resource inspection is not available for this project.";
}
async function request(url:URL,body:unknown,options:Transport):Promise<{kind:"reply";payload:unknown}|Failure>{
  try{
    const response=await(options.fetchImpl??fetch)(url,{method:"POST",credentials:"include",redirect:"error",cache:"no-store",signal:options.signal,headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    if(!response.ok)return failed(statusMessage(response.status));
    let payload:unknown;try{payload=await response.json();}catch{payload=null;}
    return{kind:"reply",payload};
  }catch{return failed("The project API is unreachable. Try inspection again.");}
}
export async function inspectProjectComposeResource(options:InspectionOptions):Promise<InspectionResult>{
  const base=configured(options.apiBaseUrl);if(!base)return failed("Resource inspection is unavailable until the project API is configured.");
  const parsed=composeResourceInspectionInputSchema.safeParse({document:options.document,projectId:options.projectId,kind:options.kind,key:options.key,expectedConfigDigest:options.expectedConfigDigest});
  if(!parsed.success||new TextEncoder().encode(parsed.data.document).length>COMPOSE_PREVIEW_MAX_BYTES)return failed("Choose a valid project resource and preview the current document again.");
  const {projectId,...body}=parsed.data,result=await request(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/compose/resources/inspect`,base),body,options);
  if(result.kind==="error")return result;
  const envelope=inspectionEnvelope.safeParse(result.payload);if(!envelope.success)return invalidInspection();
  const inspection=envelope.data.data.inspection;
  if(inspection.projectId!==projectId||inspection.kind!==body.kind||inspection.key!==body.key||inspection.configDigest!==body.expectedConfigDigest)return invalidInspection();
  return{kind:"ready",inspection};
}
export async function previewProjectComposeAttachment(options:AttachmentOptions):Promise<AttachmentResult>{
  const base=configured(options.apiBaseUrl);if(!base)return failed("Resource inspection is unavailable until the project API is configured.");
  if(!z.string().regex(/^[a-f0-9]{64}$/).safeParse(options.expectedStateDigest).success)return failed("Inspect this resource before requesting an attachment preview.");
  const parsed=composeAttachmentPreviewInputSchema.safeParse({document:options.document,projectId:options.projectId,kind:options.kind,key:options.key,service:options.service,action:options.action,expectedConfigDigest:options.expectedConfigDigest,expectedStateDigest:options.expectedStateDigest});
  if(!parsed.success||new TextEncoder().encode(parsed.data.document).length>COMPOSE_PREVIEW_MAX_BYTES)return failed("Choose a valid project resource and preview the current document again.");
  const {projectId,...body}=parsed.data,result=await request(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/compose/attachments/preview`,base),body,options);
  if(result.kind==="error")return result;
  const envelope=attachmentEnvelope.safeParse(result.payload);if(!envelope.success)return invalidAttachment();
  const preview=envelope.data.data.preview;
  if(preview.projectId!==projectId||preview.kind!==body.kind||preview.key!==body.key||preview.service!==body.service||preview.action!==body.action||preview.configDigest!==body.expectedConfigDigest||preview.stateDigest!==body.expectedStateDigest)return invalidAttachment();
  return{kind:"ready",preview};
}

export async function applyProjectComposeNetworkAttachment(options:NetworkAttachmentOptions):Promise<NetworkAttachmentResult>{
  const base=configured(options.apiBaseUrl);if(!base)return{kind:"error",message:"Resource inspection is unavailable until the project API is configured.",retryable:false};
  const parsed=composeNetworkAttachmentCommandInputSchema.safeParse({document:options.document,projectId:options.projectId,kind:options.kind,key:options.key,service:options.service,
    action:options.action,expectedConfigDigest:options.expectedConfigDigest,expectedStateDigest:options.expectedStateDigest,expectedContainerId:options.expectedContainerId});
  if(!parsed.success||new TextEncoder().encode(parsed.data.document).length>COMPOSE_PREVIEW_MAX_BYTES||!/^[-A-Za-z0-9_]{1,200}$/.test(options.idempotencyKey))
    return{kind:"error",message:"Inspect this stopped service and preview the current network attachment before applying it.",retryable:false};
  const {projectId,...body}=parsed.data;
  try{
    const response=await(options.fetchImpl??fetch)(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/compose/attachments/apply`,base),{
      method:"POST",credentials:"include",redirect:"error",cache:"no-store",signal:options.signal,
      headers:{"content-type":"application/json","idempotency-key":options.idempotencyKey},body:JSON.stringify(body)
    });
    if(!response.ok)return{kind:"error",message:statusMessage(response.status),retryable:response.status>=500};
    let payload:unknown;try{payload=await response.json();}catch{payload=null;}
    const envelope=networkAttachmentEnvelope.safeParse(payload);if(!envelope.success)return{kind:"error",message:"The API returned an invalid network attachment receipt.",retryable:true};
    const receipt=envelope.data.data.attachment;
    if(receipt.projectId!==projectId||receipt.key!==body.key||receipt.service!==body.service||receipt.attachmentAction!==body.action||receipt.containerId!==body.expectedContainerId)
      return{kind:"error",message:"The API returned a mismatched network attachment receipt.",retryable:true};
    return{kind:"ready",receipt};
  }catch{return{kind:"error",message:"The project API did not confirm the network attachment. Retry this exact proposal to recover its result.",retryable:true};}
}
