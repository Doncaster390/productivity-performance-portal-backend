import React, { useState, useEffect } from 'react';

const LinkManager = () => {
  const [links, setLinks] = useState([]);
  const [newLink, setNewLink] = useState('');
  const [newLinkTitle, setNewLinkTitle] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [allLinks, setAllLinks] = useState([]); // For admin view

  const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000';

  // Fetch approved links on mount
  useEffect(() => {
    fetchApprovedLinks();
  }, []);

  // Fetch admin links when admin logs in
  useEffect(() => {
    if (isAdmin) {
      fetchAllLinks();
    }
  }, [isAdmin]);

  const fetchApprovedLinks = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/links`);
      if (!response.ok) throw new Error('Failed to fetch links');
      const data = await response.json();
      setLinks(data);
    } catch (err) {
      console.error('Error fetching links:', err);
      setError('Failed to load links');
    }
  };

  const fetchAllLinks = async () => {
    const token = localStorage.getItem('adminToken');
    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/links`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!response.ok) throw new Error('Failed to fetch admin links');
      const data = await response.json();
      setAllLinks(data);
    } catch (err) {
      console.error('Error fetching admin links:', err);
    }
  };

  const handleLinkSubmit = async (e) => {
    e.preventDefault();
    if (!newLink.trim() || !newLinkTitle.trim()) return;

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE_URL}/api/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newLinkTitle, url: newLink })
      });

      if (!response.ok) throw new Error('Failed to submit link');
      
      setNewLink('');
      setNewLinkTitle('');
      alert('Link submitted for approval!');
    } catch (err) {
      setError('Failed to submit link');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleApproveLink = async (id) => {
    const token = localStorage.getItem('adminToken');
    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/links/${id}/approve`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) throw new Error('Failed to approve link');
      
      fetchAllLinks();
      fetchApprovedLinks();
    } catch (err) {
      console.error('Error approving link:', err);
      alert('Failed to approve link');
    }
  };

  const handleDeleteLink = async (id) => {
    const token = localStorage.getItem('adminToken');
    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/links/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) throw new Error('Failed to delete link');
      
      fetchAllLinks();
      fetchApprovedLinks();
    } catch (err) {
      console.error('Error deleting link:', err);
      alert('Failed to delete link');
    }
  };

  const handleAdminLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPassword })
      });

      if (!response.ok) {
        throw new Error('Incorrect password');
      }

      const data = await response.json();
      localStorage.setItem('adminToken', data.token);
      setIsAdmin(true);
      setShowAdminLogin(false);
      setAdminPassword('');
    } catch (err) {
      setError('Incorrect password');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleAdminLogout = () => {
    localStorage.removeItem('adminToken');
    setIsAdmin(false);
    setAllLinks([]);
  };

  const getLinkIcon = (url) => {
    if (url.toLowerCase().includes('powerpoint') || url.toLowerCase().endsWith('.pptx') || url.toLowerCase().endsWith('.ppt')) {
      return <span className="text-red-500">📄 PPTX</span>;
    } else if (url.toLowerCase().includes('powerbi')) {
      return <span className="text-yellow-500">📊 PowerBI</span>;
    } else if (url.toLowerCase().includes('excel') || url.toLowerCase().endsWith('.xlsx') || url.toLowerCase().endsWith('.xls')) {
      return <span className="text-green-500">📊 Excel</span>;
    } else {
      return <span className="text-blue-500">🔗 Link</span>;
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <div className="max-w-4xl mx-auto bg-white rounded-lg shadow-md p-6">
        <h1 className="text-3xl font-bold text-center text-gray-800 mb-8">Productivity & Performance Portal</h1>

        {error && (
          <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
            {error}
          </div>
        )}

        {/* Link Submission Form */}
        <div className="mb-8 p-4 border rounded-lg bg-blue-50">
          <h2 className="text-2xl font-semibold text-blue-800 mb-4">Submit New Link</h2>
          <form onSubmit={handleLinkSubmit} className="space-y-4">
            <div>
              <label htmlFor="linkTitle" className="block text-gray-700 text-sm font-bold mb-2">Link Title:</label>
              <input
                type="text"
                id="linkTitle"
                className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
                value={newLinkTitle}
                onChange={(e) => setNewLinkTitle(e.target.value)}
                placeholder="Enter title for the link (e.g., Q3 Sales Report)"
                required
              />
            </div>
            <div>
              <label htmlFor="linkUrl" className="block text-gray-700 text-sm font-bold mb-2">Link URL:</label>
              <input
                type="url"
                id="linkUrl"
                className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
                value={newLink}
                onChange={(e) => setNewLink(e.target.value)}
                placeholder="https://example.com/your-document.pptx"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline disabled:opacity-50"
            >
              {loading ? 'Submitting...' : 'Submit Link'}
            </button>
          </form>
        </div>

        {/* Admin Login/Logout */}
        <div className="mb-8 text-right">
          {!isAdmin ? (
            <button
              onClick={() => setShowAdminLogin(!showAdminLogin)}
              className="text-sm text-blue-500 hover:text-blue-700 focus:outline-none"
            >
              {showAdminLogin ? 'Hide Admin Login' : 'Admin Login'}
            </button>
          ) : (
            <button
              onClick={handleAdminLogout}
              className="text-sm text-red-500 hover:text-red-700 focus:outline-none"
            >
              Logout Admin
            </button>
          )}

          {showAdminLogin && !isAdmin && (
            <form onSubmit={handleAdminLogin} className="mt-2 inline-block ml-4">
              <input
                type="password"
                className="shadow appearance-none border rounded py-1 px-2 text-gray-700 leading-tight focus:outline-none focus:shadow-outline text-sm"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder="Admin PIN"
                required
              />
              <button
                type="submit"
                disabled={loading}
                className="ml-2 bg-gray-600 hover:bg-gray-700 text-white font-bold py-1 px-2 rounded focus:outline-none focus:shadow-outline text-sm disabled:opacity-50"
              >
                {loading ? 'Logging in...' : 'Login'}
              </button>
            </form>
          )}
        </div>

        {/* Admin Page */}
        {isAdmin && (
          <div className="mb-8 p-4 border rounded-lg bg-purple-50">
            <h2 className="text-2xl font-semibold text-purple-800 mb-4">Admin Dashboard</h2>
            {allLinks.filter(link => !link.approved).length === 0 ? (
              <p className="text-gray-600">No pending links for approval.</p>
            ) : (
              <ul className="space-y-3">
                {allLinks.filter(link => !link.approved).map(link => (
                  <li key={link.id} className="flex justify-between items-center bg-white p-3 rounded shadow-sm">
                    <div className="flex-grow">
                      <p className="font-semibold text-gray-800">{link.title} {getLinkIcon(link.url)}</p>
                      <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-blue-500 text-sm hover:underline">{link.url}</a>
                    </div>
                    <div className="flex space-x-2">
                      <button
                        onClick={() => handleApproveLink(link.id)}
                        className="bg-green-500 hover:bg-green-600 text-white text-sm py-1 px-3 rounded"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => handleDeleteLink(link.id)}
                        className="bg-red-500 hover:bg-red-600 text-white text-sm py-1 px-3 rounded"
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Public View Page */}
        <div className="p-4 border rounded-lg bg-green-50">
          <h2 className="text-2xl font-semibold text-green-800 mb-4">Live Performance Links</h2>
          {links.length === 0 ? (
            <p className="text-gray-600">No approved links to display yet.</p>
          ) : (
            <ul className="space-y-3">
              {links.map(link => (
                <li key={link.id} className="flex justify-between items-center bg-white p-3 rounded shadow-sm">
                  <div className="flex-grow">
                    <p className="font-semibold text-gray-800">{link.title} {getLinkIcon(link.url)}</p>
                    <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-blue-500 text-sm hover:underline">{link.url}</a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default LinkManager;
