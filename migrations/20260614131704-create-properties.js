export async function up(queryInterface, Sequelize) {
  await queryInterface.createTable('properties', {
    propertyId: {
      type: Sequelize.UUID,
      defaultValue: Sequelize.UUIDV4,
      primaryKey: true,
    },

    apaleoCode: {
      type: Sequelize.STRING,
      allowNull: false,     // e.g. "BER", "MUC"
    },

    name: {
      type: Sequelize.STRING,
      allowNull: false,
    },

    address: {
      type: Sequelize.STRING,
      allowNull: false,
    },

    apiKey: {
      type: Sequelize.STRING,
      allowNull: true,      // encrypted, used for X-API-Key header
    },

    createdBy: {
      type: Sequelize.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'userId',
      },
      onDelete: 'CASCADE',
    },

    createdAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },

    updatedAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
  });
}

export async function down(queryInterface) {
  await queryInterface.dropTable('properties');
}