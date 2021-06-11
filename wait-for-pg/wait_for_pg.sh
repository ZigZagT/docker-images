# Wait for PG to be ready
until PGPASSWORD=${DB_PASSWORD} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USERNAME} -c "select version()" &> /dev/null
do
    echo "waiting for postgres container..."
    sleep 2
done
