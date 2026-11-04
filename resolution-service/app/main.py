import os
from datetime import datetime, timezone
from typing import Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sqlalchemy import create_engine, text
from dotenv import load_dotenv
import networkx as nx

load_dotenv()
app=FastAPI(title='AeroCurrent Resolution Service',version='0.1.0')
VERSION='0.1.0'

class Clause(BaseModel):
    id: str
    clause_identifier: str
    procedure_text: str
    manual_identifier: Optional[str]=None
    revision_number: Optional[str]=None

class ResolveRequest(BaseModel):
    clause: Clause
    station_code: Optional[str]=None
    fleet_type: Optional[str]=None
    operational_role: Optional[str]=None

def matches(scope, requested):
    return not scope or not requested or requested in scope

@app.get('/health')
def health():
    return {'status':'ok','service':'aerocurrent-resolution'}

@app.post('/resolve/clause')
def resolve(data: ResolveRequest):
    try:
        url=os.getenv('DATABASE_URL')
        if not url: raise RuntimeError('DATABASE_URL is not configured')
        engine=create_engine(url,pool_pre_ping=True)
        sql=text('''
          SELECT ss.*, COALESCE(sb.identifier,rd.reference_number) source_identifier,
            COALESCE(sb.status,rd.status) source_status,
            COALESCE(sb.effective_from,rd.effective_from) effective_from,
            sb.expires_at
          FROM source_steps ss
          LEFT JOIN safety_bulletins sb ON ss.source_type='safety_bulletin' AND ss.source_id=sb.id
          LEFT JOIN regulatory_directives rd ON ss.source_type='regulatory_directive' AND ss.source_id=rd.id
          WHERE ss.target_clause_identifier=:clause
        ''')
        with engine.connect() as conn:
            records=[dict(r) for r in conn.execute(sql,{'clause':data.clause.clause_identifier}).mappings()]
        now=datetime.now(timezone.utc)
        active=[]
        for r in records:
            if r['source_status']!='active': continue
            if r['effective_from'] and r['effective_from']>now: continue
            if r.get('expires_at') and r['expires_at']<=now: continue
            if not matches(r.get('station_scope'),data.station_code): continue
            if not matches(r.get('fleet_scope'),data.fleet_type): continue
            if not matches(r.get('role_scope'),data.operational_role): continue
            active.append(r)

        # Validate the active source graph for cycles where source-to-target links exist.
        graph=nx.DiGraph()
        for r in active: graph.add_edge(str(r['source_id']),data.clause.clause_identifier)
        cycle=not nx.is_directed_acyclic_graph(graph)

        # PRD hierarchy: directive > bulletin > baseline manual.
        tier={'regulatory_directive':300,'safety_bulletin':200}
        highest=max([tier.get(x['source_type'],0) for x in active],default=0)
        winners=sorted([x for x in active if tier.get(x['source_type'],0)==highest],
                       key=lambda x:(x['sequence_no'] or 0,x['source_identifier'] or ''))
        conflict=cycle or len({str(x['source_id']) for x in winners})>1

        if not winners:
            steps=[{'text':data.clause.procedure_text,'source':'baseline_manual','status':'effective','priorityTier':100}]
        else:
            steps=[{'text':data.clause.procedure_text,'source':'baseline_manual','status':'superseded','priorityTier':100}]
            steps += [{'text':x['step_text'],'source':x['source_identifier'],'sourceType':x['source_type'],
                       'status':'conflict_unresolved' if conflict else 'effective','priorityTier':tier[x['source_type']]}
                      for x in winners]

        return {'clauseIdentifier':data.clause.clause_identifier,'manualIdentifier':data.clause.manual_identifier,
          'revisionNumber':data.clause.revision_number,
          'scope':{'stationCode':data.station_code,'fleetType':data.fleet_type,'role':data.operational_role},
          'effectiveSteps':steps,'conflictDetected':conflict,
          'conflictReason':'Cycle or multiple active highest-priority sources detected' if conflict else None,
          'supersessionLineage':[{'source':x['source_identifier'],'sourceType':x['source_type'],
                                  'priorityTier':tier[x['source_type']]} for x in active],
          'resolverVersion':VERSION,'resolvedAt':now.isoformat(),
          'operationalUseWarning':'Verify against approved airline publications and authorization workflow before operational use.'}
    except Exception as exc:
        raise HTTPException(status_code=500,detail=str(exc))
