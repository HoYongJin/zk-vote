// frontend/src/pages/admin/CreateVotePage.js
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from '../../api/axios';

// --- Style Definitions ---
const pageStyle = { fontFamily: 'sans-serif', padding: '20px', maxWidth: '600px', margin: 'auto' };
const formStyle = { display: 'flex', flexDirection: 'column', gap: '15px' };
const inputGroupStyle = { display: 'flex', flexDirection: 'column' };
const labelStyle = { marginBottom: '5px', fontWeight: 'bold' };
const inputStyle = { padding: '10px', border: '1px solid #ccc', borderRadius: '4px' };
const buttonStyle = { padding: '12px', border: 'none', borderRadius: '4px', backgroundColor: '#007bff', color: 'white', cursor: 'pointer', fontSize: '16px' };

function CreateVotePage() {
  const [name, setName] = useState('');
  const [merkleTreeDepth, setMerkleTreeDepth] = useState('');
  const [candidates, setCandidates] = useState(['']);
  const [regEndTime, setRegEndTime] = useState('');
  const navigate = useNavigate();

  const handleCandidateChange = (index, event) => {
    const newCandidates = [...candidates];
    newCandidates[index] = event.target.value;
    setCandidates(newCandidates);
  };

  const addCandidate = () => setCandidates([...candidates, '']);
  const removeCandidate = (index) => setCandidates(candidates.filter((_, i) => i !== index));

  const handleSubmit = async (event) => {
    event.preventDefault();
    const finalCandidates = candidates.filter(c => c.trim() !== '');

    if (finalCandidates.length < 1) {
      alert('At least one candidate is required.');
      return;
    }
    if (!name || !merkleTreeDepth || !regEndTime) {
      alert('Please fill out all fields.');
      return;
    }

    try {
      // 1. Send the API request with the correct data structure
      const response = await axios.post('/elections/set', {
        name,
        merkleTreeDepth: parseInt(merkleTreeDepth, 10), // Ensure it's a number
        candidates: finalCandidates,
        regEndTime,
      });

      // The API should ideally return the new election's data, including the ID
      const newElectionId = response.data?.id; 
      
      alert(`Vote created successfully!\nElection ID: ${newElectionId}\n\nNext steps:\n1. Run setUpZk.sh on the server.\n2. Run deployAll.js to deploy contracts.`);
      
      navigate('/admin'); // Navigate back to the admin dashboard on success

    } catch (error) {
      console.error('Error creating vote:', error);
      alert(`Failed to create vote: ${error.response?.data?.message || error.message}`);
    }
  };

  return (
    <div style={pageStyle}>
      <Link to="/admin">← Back to Admin Dashboard</Link>
      <h2>Create New Vote</h2>
      <form onSubmit={handleSubmit} style={formStyle}>
        <div style={inputGroupStyle}>
          <label style={labelStyle}>Vote Name:</label>
          <input style={inputStyle} type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>

        <div style={inputGroupStyle}>
          <label style={labelStyle}>Registration End Time:</label>
          <input style={inputStyle} type="datetime-local" value={regEndTime} onChange={(e) => setRegEndTime(e.target.value)} required />
        </div>

        <div style={inputGroupStyle}>
          <label style={labelStyle}>Merkle Tree Depth:</label>
          <input style={inputStyle} type="number" value={merkleTreeDepth} onChange={(e) => setMerkleTreeDepth(e.target.value)} placeholder="e.g., 10 (supports 2^10 = 1024 voters)" required />
        </div>
        
        <div style={inputGroupStyle}>
          <label style={labelStyle}>Candidates:</label>
          {candidates.map((candidate, index) => (
            <div key={index} style={{ display: 'flex', gap: '10px', marginBottom: '5px' }}>
              <input style={{...inputStyle, flex: 1}} type="text" value={candidate} onChange={(e) => handleCandidateChange(index, e)} placeholder={`Candidate ${index + 1}`} />
              <button type="button" onClick={() => removeCandidate(index)}>Remove</button>
            </div>
          ))}
          <button type="button" onClick={addCandidate}>Add Candidate</button>
        </div>
        
        <button type="submit" style={buttonStyle}>Create Vote & Get ID</button>
      </form>
    </div>
  );
}

export default CreateVotePage;