import { Track } from '../src/track/Track.js';
import { straight, arc } from '../src/track/Layout.js';
import { Vehicle, CARS } from '../src/physics/Vehicle.js';
import { Drivetrain } from '../src/physics/Drivetrain.js';
import * as THREE from 'three';

// Proving ground: 4 km straights so acceleration and braking runs never
// reach a corner, plus a 300 m constant-radius bowl for the skidpad.
const OVAL = { name:'Proving Ground', segments:[
  straight(4000,{width:24}), arc(300,180,{width:24}), straight(4000,{width:24}), arc(300,180,{width:24}) ]};
const SKIDPAD = { name:'Skidpad', segments:[ arc(120,360,{width:30}) ]};

const DT = 1/120;
const c1 = {throttle:1,brake:0,steer:0,handbrake:0};
const c2 = {throttle:0.3,brake:0,steer:0,handbrake:0};
const track = new Track(OVAL);
const pad = new Track(SKIDPAD);

function make(carIdx, trk=track, s=50) {
  const v = new Vehicle(CARS[carIdx].spec, trk);
  const i = trk.indexAt(s);
  const p = trk.sampleAt(s, new THREE.Vector3());
  const t = new THREE.Vector3().fromArray(trk.tangent, i*3);
  v.reset(p, Math.atan2(t.x, t.z));
  return v;
}
function run(v, c, seconds, cb) {
  const n = Math.round(seconds/DT);
  for (let i=0;i<n;i++){ v.update(DT,c); if (cb && cb(v, i*DT)===false) return i*DT; }
  return seconds;
}
// keeps the car pointed down the road so straight-line runs stay straight
function follow(v, trk) {
  const q = trk.query(v.position.x, v.position.z, {});
  const i = q.index;
  const t = new THREE.Vector3().fromArray(trk.tangent, i*3);
  const fwd = new THREE.Vector3(0,0,1).applyQuaternion(v.quaternion);
  const head = Math.atan2(t.x,t.z) - Math.atan2(fwd.x,fwd.z);
  const err = Math.atan2(Math.sin(head),Math.cos(head));
  // heading error is toward +X (left); positive steer is right, so negate
  return Math.max(-1,Math.min(1, -(err*2.4 - q.lateral*0.05)));
}

for (const [idx, car] of CARS.entries()) {
  const hp = Math.round(new Drivetrain(car.spec.engine).peakPowerKw*1.341);
  console.log(`\n=== ${car.name} — ${car.spec.mass} kg, ${hp} hp, ${car.spec.drivetrainLayout.toUpperCase()} ===`);

  let v = make(idx);
  run(v,{throttle:0,brake:0,steer:0,handbrake:0},2);
  const loads = v.wheels.map(w=>Math.round(w.load));
  console.log(`  static: ride height ${(v.position.y - track.query(v.position.x,v.position.z,{}).height).toFixed(3)} m · loads ${loads.join('/')} N · ${(100*(loads[0]+loads[1])/loads.reduce((a,b)=>a+b)).toFixed(0)}% front`);

  // acceleration
  v = make(idx); run(v,{throttle:0,brake:0,steer:0,handbrake:0},1);
  let t100=null,t200=null,t300=null;
  Object.assign(c1,{throttle:1,brake:0,steer:0,handbrake:0});
  run(v,c1,60,(veh,t)=>{
    c1.steer = follow(veh, track);
    if(!t100&&veh.speedKph>=100)t100=t;
    if(!t200&&veh.speedKph>=200)t200=t;
    if(!t300&&veh.speedKph>=300){t300=t;return false;}
  });
  console.log(`  0-100 ${t100?t100.toFixed(2)+'s':'—'} · 0-200 ${t200?t200.toFixed(2)+'s':'—'} · 0-300 ${t300?t300.toFixed(2)+'s':'—'}`);

  // top speed
  v = make(idx); Object.assign(c1,{throttle:1,brake:0,steer:0,handbrake:0});
  run(v,c1,48,(veh)=>{c1.steer=follow(veh,track);});
  console.log(`  top speed ${v.speedKph.toFixed(0)} km/h in gear ${v.drivetrain.gear} @ ${Math.round(v.drivetrain.rpm)} rpm`);

  // braking 100-0
  v = make(idx);
  Object.assign(c1,{throttle:1,brake:0,steer:0,handbrake:0});
  run(v,c1,40,(veh)=>{c1.steer=follow(veh,track); return veh.speedKph<100;});
  const x0=v.position.clone(); let peak=0;
  Object.assign(c1,{throttle:0,brake:1,steer:0,handbrake:0});
  const bt=run(v,c1,12,(veh)=>{c1.steer=follow(veh,track);peak=Math.max(peak,-veh.telemetry.gForceLong);return veh.speedKph>2;});
  console.log(`  100-0 km/h in ${v.position.distanceTo(x0).toFixed(1)} m / ${bt.toFixed(2)} s (peak ${peak.toFixed(2)} g)`);

  // skidpad: hold a constant radius and ramp the speed until it lets go
  v = make(idx, pad, 20);
  let bestLat=0, bestSpeed=0, targetV=8;
  Object.assign(c2,{throttle:0.3,brake:0,steer:0,handbrake:0});
  run(v,c2,110,(veh,t)=>{
    const q = pad.query(veh.position.x,veh.position.z,{});
    const i=q.index; const tan=new THREE.Vector3().fromArray(pad.tangent,i*3);
    const fwd=new THREE.Vector3(0,0,1).applyQuaternion(veh.quaternion);
    const head=Math.atan2(tan.x,tan.z)-Math.atan2(fwd.x,fwd.z);
    const err=Math.atan2(Math.sin(head),Math.cos(head));
    c2.steer=Math.max(-1,Math.min(1, -(err*2.6 - q.lateral*0.11)));
    targetV = 8 + t*0.5;                       // ramp ~0.6 m/s per second
    const dv = targetV - veh.speed;
    c2.throttle = Math.max(0, Math.min(1, dv*0.45));
    c2.brake    = Math.max(0, Math.min(1, -dv*0.25));
    if (t>4 && Math.abs(q.lateral)<10 && Math.abs(veh.telemetry.gForceLat)>bestLat){
      bestLat=Math.abs(veh.telemetry.gForceLat); bestSpeed=veh.speedKph;
    }
    return Math.abs(q.lateral) < 13;             // stop once it slides off
  });
  console.log(`  skidpad peak ${bestLat.toFixed(2)} g lateral @ ${bestSpeed.toFixed(0)} km/h (120 m radius)`);
  console.log(`  tyres ${v.wheels.map(w=>Math.round(w.tyre.temp)).join('/')} °C · wear ${v.wheels.map(w=>(w.tyre.wear*100).toFixed(1)).join('/')}%`);
}
