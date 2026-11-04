import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || true }));
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 }));

function auth(req,res,next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /,'');
  if (!token) return res.status(401).json({error:'Authentication required'});
  try { req.user = jwt.verify(token,process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({error:'Invalid or expired token'}); }
}
function roles(...allowed) {
  return (req,res,next) => allowed.includes(req.user.role) ? next() : res.status(403).json({error:'Forbidden'});
}
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);

app.get('/health',(req,res)=>res.json({status:'ok',service:'aerocurrent-api'}));

// Development-only password login. Replace with airline SSO/OIDC in deployment.
app.post('/api/auth/login',asyncRoute(async(req,res)=>{
  const {email,password}=req.body;
  if(!email || !password) return res.status(400).json({error:'email and password required'});
  const q=await db.query('SELECT * FROM users WHERE email=$1 AND is_active=true',[email]);
  const user=q.rows[0];
  if(!user?.password_hash || !(await bcrypt.compare(password,user.password_hash)))
    return res.status(401).json({error:'Invalid credentials'});
  const token=jwt.sign({sub:user.id,username:user.username,role:user.role,stationCode:user.station_code,
    fleetScope:user.fleet_scope},process.env.JWT_SECRET,{expiresIn:process.env.JWT_EXPIRES_IN||'8h'});
  res.json({token,user:{id:user.id,username:user.username,email:user.email,role:user.role,
    stationCode:user.station_code,fleetScope:user.fleet_scope}});
}));

app.get('/api/manuals',auth,asyncRoute(async(req,res)=>{
  const q=await db.query('SELECT * FROM manuals ORDER BY identifier,revision_number DESC'); res.json(q.rows);
}));
app.post('/api/manuals',auth,roles('admin','technical_publications'),asyncRoute(async(req,res)=>{
  const {identifier,title,revisionNumber,publicationDate,effectiveDate,fleetTypes=[]}=req.body;
  if(!identifier||!title||!revisionNumber) return res.status(400).json({error:'identifier, title and revisionNumber required'});
  const q=await db.query(`INSERT INTO manuals(identifier,title,revision_number,publication_date,effective_date,fleet_types)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[identifier,title,revisionNumber,publicationDate||null,effectiveDate||null,fleetTypes]);
  res.status(201).json(q.rows[0]);
}));
app.get('/api/manuals/:id/clauses',auth,asyncRoute(async(req,res)=>{
  const q=await db.query('SELECT * FROM manual_clauses WHERE manual_id=$1 ORDER BY sequence_no,clause_identifier',[req.params.id]);
  res.json(q.rows);
}));
app.get('/api/bulletins',auth,asyncRoute(async(req,res)=>{
  const q=await db.query('SELECT * FROM safety_bulletins ORDER BY issue_date DESC'); res.json(q.rows);
}));
app.post('/api/bulletins',auth,roles('admin','technical_publications','safety_officer'),asyncRoute(async(req,res)=>{
  const b=req.body;
  if(!b.identifier||!b.title||!b.issueDate||!b.effectiveFrom)
    return res.status(400).json({error:'identifier, title, issueDate and effectiveFrom required'});
  const q=await db.query(`INSERT INTO safety_bulletins(identifier,title,category,issue_date,effective_from,expires_at,
    affected_stations,affected_roles,fleet_scope,source_uri) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [b.identifier,b.title,b.category||null,b.issueDate,b.effectiveFrom,b.expiresAt||null,
     b.affectedStations||[],b.affectedRoles||[],b.fleetScope||[],b.sourceUri||null]);
  res.status(201).json(q.rows[0]);
}));
app.get('/api/procedures/clause/:clauseId',auth,asyncRoute(async(req,res)=>{
  const q=await db.query(`SELECT c.id,c.clause_identifier,c.procedure_text,m.identifier AS manual_identifier,
    m.revision_number FROM manual_clauses c JOIN manuals m ON m.id=c.manual_id WHERE c.id=$1`,[req.params.clauseId]);
  if(!q.rows[0]) return res.status(404).json({error:'Clause not found'});
  const response=await fetch(`${process.env.PYTHON_SERVICE_URL||'http://localhost:8000'}/resolve/clause`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({clause:q.rows[0],station_code:req.query.stationCode||req.user.stationCode||null,
      fleet_type:req.query.fleetType||null,operational_role:req.query.role||req.user.role})
  });
  if(!response.ok) throw new Error(`Resolution service returned ${response.status}`);
  res.json(await response.json());
}));
app.post('/api/acknowledgments',auth,asyncRoute(async(req,res)=>{
  const b=req.body, station=req.user.stationCode;
  if(!station) return res.status(400).json({error:'User has no assigned station'});
  if(!b.bulletinId&&!b.directiveId&&!b.procedureIdentifier)
    return res.status(400).json({error:'A bulletin, directive or procedure identifier is required'});
  const state=b.state||'acknowledged';
  if(!['pending','acknowledged','rejected'].includes(state)) return res.status(400).json({error:'Invalid state'});
  const q=await db.query(`INSERT INTO staff_acknowledgments(user_id,bulletin_id,directive_id,procedure_identifier,
    station_code,acknowledgment_state,acknowledged_at) VALUES($1,$2,$3,$4,$5,$6,
    CASE WHEN $6='acknowledged' THEN NOW() ELSE NULL END) RETURNING *`,
    [req.user.sub,b.bulletinId||null,b.directiveId||null,b.procedureIdentifier||null,station,state]);
  res.status(201).json(q.rows[0]);
}));
app.get('/api/acknowledgments/mine',auth,asyncRoute(async(req,res)=>{
  const q=await db.query('SELECT * FROM staff_acknowledgments WHERE user_id=$1 ORDER BY created_at DESC',[req.user.sub]);
  res.json(q.rows);
}));
app.get('/api/analytics/overview',auth,roles('admin','station_manager','technical_publications','safety_officer','auditor'),
asyncRoute(async(req,res)=>{
  const [m,b,d,c,a]=await Promise.all([
    db.query("SELECT COUNT(*)::int n FROM manuals WHERE status='active'"),
    db.query("SELECT COUNT(*)::int n FROM safety_bulletins WHERE status='active'"),
    db.query("SELECT COUNT(*)::int n FROM regulatory_directives WHERE status='active'"),
    db.query("SELECT COUNT(*)::int n FROM compiled_procedures WHERE conflict_detected=true AND valid_until IS NULL"),
    db.query(`SELECT station_code,COUNT(*)::int total,COUNT(*) FILTER(WHERE acknowledgment_state='acknowledged')::int acknowledged
      FROM staff_acknowledgments GROUP BY station_code`)
  ]);
  res.json({activeManuals:m.rows[0].n,activeBulletins:b.rows[0].n,openDirectives:d.rows[0].n,
    flaggedConflicts:c.rows[0].n,stationAcknowledgments:a.rows.map(x=>({...x,
      percentage:x.total?Number((100*x.acknowledged/x.total).toFixed(1)):0}))});
}));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Internal server error'});});
app.listen(process.env.PORT||4000,()=>console.log(`AeroCurrent API on ${process.env.PORT||4000}`));
