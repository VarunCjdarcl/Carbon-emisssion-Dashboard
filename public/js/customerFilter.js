// Searchable customer dropdown.

const CustomerFilter = (() => {
  const state = {
    customers: [],
    selected: null,         // customer code or null = all
    selectedName: 'All Customers',
  };
  let onChangeCb = () => {};

  async function init({ onChange }) {
    onChangeCb = onChange || (() => {});
    try {
      const res = await Util.api('/api/emissions/customer-list');
      state.customers = res.customers || [];
    } catch (e) {
      console.warn('Customer list failed', e);
    }
    renderList('');
    document.getElementById('customerBtn').addEventListener('click', e => {
      e.stopPropagation();
      const dd = document.getElementById('customerDropdown');
      dd.hidden = !dd.hidden;
      if (!dd.hidden) document.getElementById('customerSearch').focus();
    });
    document.getElementById('customerSearch').addEventListener('input', e => {
      renderList(e.target.value);
    });
    document.getElementById('resetCustomer').addEventListener('click', () => {
      setSelected(null, 'All Customers');
      onChangeCb(getCurrent());
    });
    document.addEventListener('click', e => {
      const dd = document.getElementById('customerDropdown');
      if (dd.hidden) return;
      if (dd.contains(e.target) || e.target.closest('#customerBtn')) return;
      dd.hidden = true;
    });
  }

  function renderList(q) {
    const list = document.getElementById('customerList');
    list.innerHTML = '';
    const items = [{ code: null, name: 'All Customers', sub: 'Show all' }]
      .concat(state.customers.map(c => ({
        code: c.code, name: c.name, sub: c.code,
      })));
    const filt = q
      ? items.filter(c => c.name.toLowerCase().includes(q.toLowerCase()))
      : items;
    for (const c of filt) {
      const row = document.createElement('div');
      row.className = 'customer-item' + (c.code === state.selected ? ' selected' : '');
      const initials = (c.name || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
      row.innerHTML = `
        <div class="ci-avatar">${Util.escapeHtml(initials)}</div>
        <div class="ci-text">
          <div class="ci-name">${Util.escapeHtml(c.name)}</div>
          <div class="ci-sub">${Util.escapeHtml(c.sub || '')}</div>
        </div>
      `;
      row.addEventListener('click', () => {
        setSelected(c.code, c.name);
        document.getElementById('customerDropdown').hidden = true;
        onChangeCb(getCurrent());
      });
      list.appendChild(row);
    }
  }

  function setSelected(code, name) {
    state.selected = code;
    state.selectedName = name;
    document.getElementById('customerLabel').textContent = name;
    renderList(document.getElementById('customerSearch').value || '');
  }

  function getCurrent() {
    return { code: state.selected, name: state.selectedName, customers: state.customers };
  }

  function show(visible) {
    document.getElementById('customerControl').hidden = !visible;
  }

  return { init, getCurrent, show };
})();
