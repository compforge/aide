import type { PluginPackage } from "@compforge/aide-plugin";
import { TicketKind } from "./connector-contract.ts";
export default { pluginId:"tests/connector-plugin",version:"1.0.0",async activate(context){
  context.controllers.register<{operation:string},{done?:boolean;result?:unknown}>({
    resourceType:{apiVersion:"tests.aide.dev/v1alpha1",kind:"EnvironmentCheck"},
    async reconcile(execution,resource){
      if(resource.status.done)return;
      const direct=[];
      for(const connector of await context.connectors.list(TicketKind)) direct.push(await context.connectors.get(TicketKind,connector).read("direct"));
      const scoped=execution.verbs.connectors({timeoutMs:1000});const viaVerb=[];
      for(const connector of await scoped.list(TicketKind)) viaVerb.push(await scoped.get(TicketKind,connector).read("verb"));
      const [first]=await scoped.list(TicketKind);let timeout="";
      if(first)try{await execution.verbs.connectors({timeoutMs:20}).get(TicketKind,first).wait(1000);}catch(error){timeout=String(error);}
      await context.resources.patchStatus(resource,{done:true,result:{direct,viaVerb,timeout}});
    },
  });
}} satisfies PluginPackage;
