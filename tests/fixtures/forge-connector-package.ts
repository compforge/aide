import type { ConnectorDefinition, ConnectorPackage } from "@compforge/aide-connector";
import type { ForgeOperations, PullRequestScanCursor } from "@compforge/aide-connector/forge";
const kind = "forge";
const definition:ConnectorDefinition<Record<string,unknown>,ForgeOperations>={type:"fixture-forge",kind,version:"v1",config:{parse(value){return value as Record<string,unknown>;}},create(context){
  if(!context.env("EXTERNAL_TOKEN"))throw new Error("Missing credential");
  const repository={forge:{name:"forge.external"},path:"org/repo"};
  const pull={repository,number:1,state:"merged" as const,title:"External merge",headSha:"head",mergedAt:new Date().toISOString(),url:"https://forge.example/org/repo/pull/1",conflictState:"unknown" as const,mergeReadiness:"unknown" as const};
  return {metadata:{forge:"forge.external",provider:"fixture"},handlers:{
    async listRepositories(){return {items:[repository]};},
    async scanPullRequests(){return {items:[pull],cursor:"external-cursor" as PullRequestScanCursor,pending:false,complete:true,issues:[]};},
    async listPullRequests(){return {items:[{repository,number:1}]};},
    async getPullRequest(){return pull;},
    async getPullRequestReview(){return {key:{repository,number:1},reviewThreadState:"none",observedAt:new Date().toISOString()};},
    async listPullRequestComments(){return [];},
  }};
}};
export default {id:"fixture-forge",version:"1.0.0",connectors:[definition]} satisfies ConnectorPackage;
