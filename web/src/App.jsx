import { useEffect, useState } from 'react';
import { api } from './api.js';
import Connect from './steps/Connect.jsx';
import Discover from './steps/Discover.jsx';
import Configure from './steps/Configure.jsx';
import Deploy from './steps/Deploy.jsx';
import Agent from './steps/Agent.jsx';

const STEPS = ['Connect', 'Discover', 'Configure schema', 'Create data stream'];

export default function App() {
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState({ mce: false, salesforce: false });
  // Selected DEs with their fetched fields: [{ id, key, name, fields, rowCount }]
  const [selected, setSelected] = useState([]);
  // Built schemas from the server, handed to the deploy step.
  const [built, setBuilt] = useState({ schemas: [], yaml: '' });

  const refresh = () => api.status().then(setStatus).catch(() => {});
  useEffect(() => { refresh(); }, []);

  const ready = [status.mce, status.mce, selected.length > 0, built.schemas.some((s) => s.valid)];

  return (
    <div className="app">
      <header>
        <h1>MCE to MC Next migrator</h1>
        <p>Move Data Extensions to Data Cloud data lake objects, one step at a time.</p>
      </header>

      <nav className="steps">
        {STEPS.map((label, i) => (
          <button key={label} className={i === step ? 'active' : ''} disabled={i > 0 && !ready[i - 1]} onClick={() => setStep(i)}>
            <span>{i + 1}</span> {label}
          </button>
        ))}
      </nav>

      <main>
        {step === 0 && <Connect status={status} refresh={refresh} next={() => setStep(1)} />}
        {step === 1 && <Discover selected={selected} setSelected={setSelected} next={() => setStep(2)} />}
        {step === 2 && <Configure selected={selected} onBuilt={setBuilt} next={() => setStep(3)} />}
        {step === 3 && <Deploy built={built} status={status} />}
      </main>

      <Agent enabled={!!status.agent} />
    </div>
  );
}
