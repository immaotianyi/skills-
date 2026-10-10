const packButton = document.querySelector('#packBtn');

if (packButton) {
  packButton.textContent = '下载 Evidence Pack v1.2';
  packButton.title = '下载带完整性元数据的 Evidence Pack v1.2；API 默认 v1.1 仍保留用于兼容旧客户端。';
  packButton.onclick = () => {
    if (current) location.href = `/api/projects/${current.project.id}/evidence-pack?version=1.2`;
  };
}
