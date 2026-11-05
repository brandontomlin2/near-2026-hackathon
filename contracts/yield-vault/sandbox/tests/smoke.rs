#[tokio::test]
async fn sandbox_starts() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let acc = worker.dev_create_account().await?;
    assert!(acc.view_account().await?.balance.as_yoctonear() > 0);
    Ok(())
}
